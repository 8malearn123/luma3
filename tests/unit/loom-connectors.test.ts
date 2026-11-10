import { describe, expect, it } from 'vitest';
import {
  applyPackQuality, assembleTransactions, checkHeader, computeMetrics, MetricContext, normalizeRows, packVocabulary, parseCsv, qualityGate, registeredSectorPacks,
  restaurantPack, retailPack, runEngine, sectorPack, signBody, SignatureError, statusOf, toCsv, TEMPLATES, SOURCE_ENTITIES, verifySignature, type Mapping,
} from '@/loom';
import { netOf } from '@/loom/connectors/generic/staged';
import { addDays } from '@/loom/util/time';
import { datasetBuilder, NOW, profileWith, TODAY } from '../helpers/loom-dataset';

const M: Mapping = {
  timezone: 'Asia/Riyadh', currency: 'SAR', money_unit: 'major', columns: { transactions: { id: 'order_no' } },
  status_map: { done: 'fulfilled', refunded: 'cancelled_customer' }, revenue_basis: { amounts_include_tax: true, subtract_refunds: true, total_is_after_discount: true },
};

describe('CSV parsing', () => {
  it('handles quotes, escaped quotes, commas, CRLF and a BOM; reports column-count errors', () => {
    const p = parseCsv('﻿id,name,price\r\n1,"Coffee, dark","10.5"\r\n2,"He said ""hi""",3\r\n3,short\r\n');
    expect(p.header).toEqual(['id', 'name', 'price']);
    expect(p.rows[0]).toEqual({ id: '1', name: 'Coffee, dark', price: '10.5' });
    expect(p.rows[1]!.name).toBe('He said "hi"');
    expect(p.errors).toContain('row_4:column_count');
    expect(parseCsv('').errors).toContain('empty_file');
    expect(parseCsv('a,a\n1,2\n').errors).toContain('duplicate_column:a');
    expect(parseCsv(toCsv(['a', 'b'], [['x,y', 'q"z']])).rows[0]).toEqual({ a: 'x,y', b: 'q"z' });
  });

  it('every template documents its fields in both languages and has an example', () => {
    for (const e of SOURCE_ENTITIES) {
      const t = TEMPLATES[e];
      expect(t.key.every((k) => t.fields.some((f) => f.field === k))).toBe(true);
      for (const f of t.fields) { expect(f.doc.ar).toBeTruthy(); expect(f.doc.en).toBeTruthy(); }
      expect(Object.keys(t.example).every((k) => t.fields.some((f) => f.field === k))).toBe(true);
    }
  });
});

describe('Mapping step: normalisation', () => {
  it('renames columns, converts money/dates in the mapping timezone, normalises statuses, reports unmapped ones', () => {
    const r = normalizeRows('transactions', [
      { order_no: 'A', status: 'done', occurred_at: '2026-11-01 10:00', total: '115.00', tax: '15.00' },
      { order_no: 'B', status: 'REFUNDED', occurred_at: '2026-11-01T07:00:00Z', total: '50', refunded: '50' },
      { order_no: 'C', status: 'parked', occurred_at: '2026-11-01', total: '5' },
      { order_no: 'D', status: 'done', occurred_at: 'yesterday', total: 'x' },
    ], M);
    expect(r.rows.map((x) => x.data.status)).toEqual(['fulfilled', 'cancelled_customer', null]);
    expect(r.rows[0]!.data).toMatchObject({ id: 'A', total: 11500, tax: 1500, source_status: 'done', occurred_at: Date.parse('2026-11-01T07:00:00Z') });
    expect(r.rows[1]!.data.occurred_at).toBe(Date.parse('2026-11-01T07:00:00Z'));
    expect(r.unmapped_statuses).toEqual(['parked']);
    expect(r.errors.map((e) => `${e.row}:${e.field}:${e.code}`)).toEqual(['5:occurred_at:invalid_value', '5:total:invalid_value']);
    expect(statusOf(M, 'fulfilled')).toBe('fulfilled');
    // Minor units are taken as is.
    expect(normalizeRows('offerings', [{ id: 'P', kind: 'product', name: 'n', price: '1250' }], { ...M, money_unit: 'minor' }).rows[0]!.data.price).toBe(1250);
  });

  it('dedupe keys are stable; `_op=delete` makes a tombstone; versions change only with content', () => {
    const a = normalizeRows('offerings', [{ id: 'P1', kind: 'product', name: 'n', price: '1' }], M).rows[0]!;
    const b = normalizeRows('offerings', [{ id: 'P1', kind: 'product', name: 'n', price: '1', ignored: 'x' }], M).rows[0]!;
    const c = normalizeRows('offerings', [{ id: 'P1', kind: 'product', name: 'n', price: '2' }], M).rows[0]!;
    expect(a.source_id).toBe('P1');
    expect(a.source_version).toBe(b.source_version);
    expect(c.source_version).not.toBe(a.source_version);
    expect(normalizeRows('offerings', [{ id: 'P1', _op: 'delete' }], M).rows[0]).toMatchObject({ op: 'delete', source_id: 'P1' });
    const lines = normalizeRows('transaction_lines', [{ transaction_id: 'T', offering_id: 'P', line_total: '1' }, { transaction_id: 'T', offering_id: 'P', line_total: '1' }], M).rows;
    expect(lines.map((l) => l.source_id)).toEqual(['T:P#1', 'T:P#2']);
  });

  it('privacy: contact-like columns are refused for customers and transactions', () => {
    expect(checkHeader('customers', ['pseudo_id', 'full_name'], null).map((e) => e.code)).toEqual(['pii_column']);
    expect(checkHeader('transactions', ['id', 'status', 'occurred_at', 'total', 'customer_email'], null).map((e) => e.code)).toEqual(['pii_column']);
    expect(checkHeader('offerings', ['id', 'kind', 'name', 'price'], null)).toEqual([]);
  });

  it('revenue basis is applied exactly as defined in the mapping', () => {
    const t = { gross: 12000, discount: 2000, tax: 1500, total: 11500, refunded: 1000 };
    expect(netOf({ amounts_include_tax: true, subtract_refunds: true, total_is_after_discount: true }, t)).toBe(9000);
    expect(netOf({ amounts_include_tax: false, subtract_refunds: true, total_is_after_discount: true }, t)).toBe(10500);
    expect(netOf({ amounts_include_tax: true, subtract_refunds: false, total_is_after_discount: false }, t)).toBe(8500);
    const [tx] = assembleTransactions(
      [{ id: 'T', __id: 'T', status: 'fulfilled', source_status: 'done', total: 11500, tax: 1500, refunded: 0, occurred_at: 1 }],
      [{ __id: 'T:A#1', transaction_id: 'T', offering_id: 'A', qty: 1, line_total: 7500 }, { __id: 'T:B#1', transaction_id: 'T', offering_id: 'B', qty: 1, line_total: 4000 }],
      { amounts_include_tax: true, subtract_refunds: true, total_is_after_discount: true });
    expect(tx!.net_minor).toBe(10000);
    expect(tx!.lines.map((l) => l.net_minor)).toEqual([6521, 3479]);
    expect(tx!.consistent).toBe(true);
    expect(tx!.customer_ref).toBe('anon:T');
  });
});

describe('Webhook signatures', () => {
  it('verifies valid, rejects tampered, foreign and replayed requests', () => {
    const now = new Date('2026-11-09T09:00:00Z');
    const t = Math.floor(now.getTime() / 1000);
    const sig = signBody('whsec_a', '{"x":1}', t);
    expect(verifySignature('whsec_a', '{"x":1}', sig, { now })).toBe(t);
    const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as SignatureError).code; } };
    expect(code(() => verifySignature('whsec_a', '{"x":2}', sig, { now }))).toBe('bad_signature');
    expect(code(() => verifySignature('whsec_b', '{"x":1}', sig, { now }))).toBe('bad_signature');
    expect(code(() => verifySignature('whsec_a', '{"x":1}', sig, { now: new Date(now.getTime() + 301_000) }))).toBe('stale_timestamp');
    expect(code(() => verifySignature('whsec_a', '{"x":1}', null, { now }))).toBe('missing_signature');
    expect(code(() => verifySignature('whsec_a', '{"x":1}', 't=abc,v1=zz', { now }))).toBe('bad_signature');
  });
});

/** A small store: P1 best seller with little stock; P5 slow mover; P3 ⇒ P4 basket affinity; a verified event in 10 days. */
function store() {
  const b = datasetBuilder();
  b.ds.business.sector = 'retail';
  const p = (name: string, price: number, cost: number) => b.product({ name, price_minor: price, cost });
  const P1 = p('Coffee', 6000, 3000), P3 = p('Grinder', 22000, 12000), P4 = p('Mug', 4500, 2000), P5 = p('Kettle', 15000, 8000);
  b.item({ name: 'Coffee', usage: 'sellable', on_hand: 6, reorder_level: 10, offering_id: P1.id, unit: 'unit', sold_90d: 50 });
  b.item({ name: 'Kettle', usage: 'sellable', on_hand: 90, offering_id: P5.id, unit: 'unit', sold_90d: 1 });
  b.item({ name: 'Mug', usage: 'sellable', on_hand: 40, offering_id: P4.id, unit: 'unit', sold_90d: 12 });
  b.item({ name: 'Grinder', usage: 'sellable', on_hand: 20, offering_id: P3.id, unit: 'unit', sold_90d: 6 });
  const customers = Array.from({ length: 25 }, () => b.customer({ consents: { marketing: true } }));
  for (let i = 0; i < 50; i++) {
    b.sale({ offering: P1, customer: customers[i % 25]!, daysAgo: 1 + i });
    const tx = b.ds.transactions.at(-1)!;
    const add = (o: typeof P1) => { tx.lines.push({ ...tx.lines[0]!, id: `${tx.id}-${o.id}`, offering_id: o.id, net_minor: o.price_minor, line_total_minor: o.price_minor }); tx.net_minor += o.price_minor; tx.total_minor += o.price_minor; tx.gross_minor += o.price_minor; };
    if (i % 4 === 0) add(P4);
    if (i % 8 === 0) add(P3);
    if (i === 5) add(P5);
  }
  b.ds.calendar.push({ id: 'ev1', title: 'National Day', kind: 'national', starts_on: addDays(TODAY, 10), ends_on: addDays(TODAY, 11), verified: true, has_source: true });
  const ds = b.finalize();
  return { ds, P1, P3, P4, P5 };
}

describe('Retail sector pack', () => {
  it('is registered with the restaurant skeleton; vocabulary differs from beauty', () => {
    expect(registeredSectorPacks()).toEqual(expect.arrayContaining(['beauty', 'retail', 'restaurant']));
    expect(sectorPack('retail')).toBe(retailPack);
    expect(restaurantPack.version).toMatch(/skeleton/);
    expect(packVocabulary('retail', 'ar').offering).toBe('منتج');
    expect(packVocabulary('beauty', 'ar').offering).toBe('خدمة');
    for (const p of [retailPack, restaurantPack]) for (const ids of Object.values(p.interventions)) for (const id of ids) expect(p.catalog[id]).toBeTruthy();
  });

  it('detects stockout risk, slow movers, basket cross-sell and reorder-before-promotion with explained cards', () => {
    const { ds, P1, P3, P4, P5 } = store();
    const ctx = new MetricContext(ds, { cost_completeness_threshold: 0.8 });
    const metrics = computeMetrics(ctx, { sector: 'retail' });
    const quality = applyPackQuality(qualityGate(ctx), retailPack);
    expect(quality.overall).not.toBe('insufficient');
    const r = runEngine({ ds, ctx, metrics, quality, profile: profileWith(), pack: retailPack, params: {} });
    const by = (id: string) => r.opportunities.find((o) => o.detector_id === id);
    expect(by('stockout_risk')).toMatchObject({ category: 'stockout_risk', subject: { offering_ids: [P1.id] }, card: { recommended_action: { kind: 'restock' } } });
    expect(by('retail_slow_mover_bundle')).toMatchObject({ category: 'slow_mover_bundle', subject: { offering_ids: [P1.id, P5.id] } });
    expect(by('basket_cross_sell')).toMatchObject({ category: 'cross_sell_affinity', subject: { offering_ids: [P4.id, P3.id] }, card: { recommended_action: { intervention_id: 'bundle_with_service' } } });
    const reorder = by('reorder_before_promotion')!;
    expect(reorder.category).toBe('capacity_prerequisite');
    expect(reorder.card.recommended_action.kind).toBe('restock');
    expect(reorder.card.title.en).toContain('National Day');
    // No beauty-only detector ran (no quiet-capacity card for a store).
    expect(by('quiet_capacity')).toBeUndefined();
    // Fulfilment capacity is unknown without staff/vehicle windows, and the cards say so.
    expect(by('basket_cross_sell')!.card.limitations.map((l) => l.en).join(' ')).toMatch(/not recorded/);
    expect(NOW).toBeTruthy();
  });

  it('quality model: inventory replaces staff schedules for a store', () => {
    const { ds } = store();
    const q = qualityGate(new MetricContext(ds, { cost_completeness_threshold: 0.8 }));
    expect(q.domains.capacity.level).toBe('insufficient');
    const rq = applyPackQuality(q, retailPack);
    expect(rq.overall).toBe(q.domains.sales.level === 'ok' && q.domains.inventory.level === 'ok' && q.domains.economics.level === 'ok' ? 'ok' : 'limited');
  });
});
