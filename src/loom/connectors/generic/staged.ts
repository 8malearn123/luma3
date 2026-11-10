import { withTenant, type Tx } from '../../db';
import type {
  CanonicalBusiness, CanonicalEntity, CostFact, Customer, DemandSignal, InventoryItem, Offering, OfferingRequirement, Resource, Review, Transaction, CapacityWindow,
} from '../../contracts/canonical';
import type { ConnectionHealth, ConnectionRef, ConnectorManifest, LoomConnector, PulledRecord, PullResult } from '../../contracts/connector';
import { L } from '../../util/text';
import { localToMs } from '../../util/time';
import { isConsistent, splitNet } from '../luma/normalize';
import { describeRevenueBasis, mappingSchema, type Mapping, type RevenueBasis } from './mapping';
import { readLive } from './store';
import { SOURCE_ENTITIES, TEMPLATES } from './templates';

/**
 * Base of the generic connectors (CSV import, REST pull, inbound webhooks).
 * Their sources are not queryable at analysis time, so a sync stages
 * normalised rows in loom.canonical_records; pull() assembles canonical
 * records from that store (read-only, inside withTenant(business_id)).
 * Transactions are assembled with their lines; inventory sales and customer
 * visits are derived from fulfilled transactions when the source omits them.
 */
type Row = Record<string, unknown>;
const DAY = 86_400_000;

export async function readMapping(trx: Tx, businessId: string, connectionId: string): Promise<Mapping | null> {
  const m = await trx.selectFrom('loom.source_mappings').select('field_map').where('business_id', '=', businessId).where('connection_id', '=', connectionId).where('entity', '=', '*').executeTakeFirst();
  if (!m) return null;
  const p = mappingSchema.safeParse(m.field_map);
  return p.success ? p.data : null;
}

export function netOf(b: RevenueBasis, t: { gross: number; discount: number; tax: number; total: number; refunded: number }) {
  let net = b.total_is_after_discount ? t.total : t.gross - t.discount;
  if (b.amounts_include_tax) net -= t.tax;
  if (b.subtract_refunds) net -= t.refunded;
  return Math.max(0, net);
}

async function all(trx: Tx, conn: ConnectionRef, entity: string): Promise<Row[]> {
  const out: Row[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await readLive(trx, conn.business_id, conn.id, entity, after, 5000);
    for (const r of page) out.push({ ...(r.data as Row), __id: r.source_id, __v: r.source_version });
    if (page.length < 5000) return out;
    after = page[page.length - 1]!.source_id;
  }
}

const rec = (r: Row, data: unknown): PulledRecord => ({ op: 'upsert', source_id: String(r.__id), source_version: String(r.__v), data });
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

export function assembleTransactions(txs: Row[], lines: Row[], basis: RevenueBasis): Transaction[] {
  const byTx = new Map<string, Row[]>();
  for (const l of lines) byTx.set(String(l.transaction_id), [...(byTx.get(String(l.transaction_id)) ?? []), l]);
  const out: Transaction[] = [];
  for (const t of txs) {
    if (!t.status) continue; // unmapped source status: excluded and reported by the review
    const ls = (byTx.get(String(t.id)) ?? []).sort((a, b) => String(a.__id).localeCompare(String(b.__id)));
    const lineTotals = ls.map((l) => num(l.line_total));
    const gross = t.gross === null || t.gross === undefined ? lineTotals.reduce((a, b) => a + b, 0) : num(t.gross);
    const amounts = { gross, discount: num(t.discount), tax: num(t.tax), total: num(t.total), refunded: num(t.refunded) };
    const net = netOf(basis, amounts);
    const shares = splitNet(net, lineTotals);
    const status = t.status as Transaction['status'];
    out.push({
      id: String(t.id), kind: (t.kind as Transaction['kind']) ?? 'order', status, source_status: String(t.source_status ?? t.status),
      channel: str(t.channel) ?? 'in_store', origin: null, customer_ref: str(t.customer_ref) ?? `anon:${t.id}`,
      gross_minor: gross, discount_minor: amounts.discount, tax_minor: amounts.tax, total_minor: amounts.total, refunded_minor: amounts.refunded,
      net_minor: net, occurred_at: num(t.occurred_at), campaign_id: str(t.campaign_id), has_coupon: t.coupon === true, platform_fee_minor: num(t.platform_fee),
      lines: ls.map((l, i) => ({
        id: String(l.__id), offering_id: String(l.offering_id), resource_ids: (l.resource_ids as string[] | null) ?? [], qty: num(l.qty, 1),
        net_minor: shares[i] ?? 0, line_total_minor: num(l.line_total), cost_direct_minor: l.cost_direct === null || l.cost_direct === undefined ? null : num(l.cost_direct),
        starts_at: num(l.starts_at, num(t.occurred_at)), duration_min: (l.duration_min as number | null) ?? null,
      })),
      consistent: isConsistent({ subtotal_minor: gross, total_minor: amounts.total, refunded_minor: amounts.refunded, status }, lineTotals),
    });
  }
  return out;
}

export abstract class StagedConnector implements LoomConnector {
  abstract readonly kind: string;
  abstract readonly version: string;

  describe(): ConnectorManifest {
    return {
      kind: this.kind, version: this.version,
      entities: SOURCE_ENTITIES.map((e) => ({ entity: (e === 'transaction_lines' ? 'transactions' : e) as CanonicalEntity, fields: TEMPLATES[e].fields.map((f) => f.field), incremental: true })),
      revenue_basis: 'defined per connection in the mapping step (source_mappings.revenue_basis)',
      status_map: {}, timezone_source: 'mapping.timezone',
    };
  }

  async healthcheck(conn: ConnectionRef): Promise<ConnectionHealth> {
    const m = await withTenant(conn.business_id, (trx) => readMapping(trx, conn.business_id, conn.id));
    return m ? { status: 'ok', checked_at: new Date().toISOString() } : { status: 'degraded', checked_at: new Date().toISOString(), detail: 'mapping_missing' };
  }

  async pull(conn: ConnectionRef, entity: CanonicalEntity, cursor: string | null, limit: number): Promise<PullResult> {
    if (cursor) return { records: [], next_cursor: null }; // every entity is returned in one page (bounded by the store)
    void limit;
    const asOf = (conn.as_of ?? new Date()).getTime();
    return withTenant(conn.business_id, async (trx) => {
      const m = await readMapping(trx, conn.business_id, conn.id);
      if (!m) return { records: [], next_cursor: null };
      return { records: await this.assemble(trx, conn, entity, m, asOf), next_cursor: null };
    });
  }

  private async assemble(trx: Tx, conn: ConnectionRef, entity: CanonicalEntity, m: Mapping, asOf: number): Promise<PulledRecord[]> {
    const sales = async () => assembleTransactions(await all(trx, conn, 'transactions'), await all(trx, conn, 'transaction_lines'), m.revenue_basis).filter((t) => t.status === 'fulfilled' && t.consistent);
    switch (entity) {
      case 'business': {
        const b = await trx.selectFrom('loom.businesses').selectAll().where('id', '=', conn.business_id).executeTakeFirst();
        const txs = await all(trx, conn, 'transactions');
        const first = txs.reduce((mn, t) => Math.min(mn, num(t.occurred_at, Infinity)), Infinity);
        const created = Math.min(first, b ? b.created_at.getTime() : asOf);
        const data: CanonicalBusiness = {
          id: conn.business_id, sector: b?.sector_pack ?? 'retail', subsector: null, city: b?.city ?? null, timezone: m.timezone, currency: m.currency,
          locale: b?.locale === 'en' ? 'en' : 'ar', created_at: Number.isFinite(created) ? created : asOf,
        };
        return [{ op: 'upsert', source_id: conn.business_id, source_version: '1', data }];
      }
      case 'offerings': return (await all(trx, conn, 'offerings')).map((o) => rec(o, {
        id: String(o.id), kind: o.kind, source_kind: String(o.kind), name: L(String(o.name), String(o.name_en ?? o.name)), price_minor: num(o.price),
        status: o.status ?? 'active', category_id: str(o.category), duration_min: (o.duration_min as number | null) ?? null, buffer_min: num(o.buffer_min),
        has_image: o.has_image === true, has_description: o.has_description === true, recorded_cost_minor: (o.cost as number | null) ?? null,
        visible: o.visible !== false, product_id: o.kind === 'product' ? String(o.id) : null, location_id: null,
      } as Offering));
      case 'offering_requirements': {
        const reqs = (await all(trx, conn, 'offering_requirements')).map((r) => rec(r, {
          offering_id: String(r.offering_id), type: r.type, ref_id: str(r.ref_id), quantity: num(r.quantity, 1), unit: String(r.unit ?? 'unit'), confidence: r.confidence ?? 'recipe',
        } as OfferingRequirement));
        // A resource's `skills` (offering ids) are skill requirements, as LUMA's service_staff.
        const seen = new Set(reqs.map((r) => r.source_id));
        for (const res of await all(trx, conn, 'resources')) {
          for (const off of (res.skills as string[] | null) ?? []) {
            const id = `${off}:skill:${res.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            reqs.push({ op: 'upsert', source_id: id, source_version: String(res.__v), data: { offering_id: off, type: 'skill', ref_id: String(res.id), quantity: 1, unit: 'unit', confidence: 'recipe' } satisfies OfferingRequirement });
          }
        }
        return reqs;
      }
      case 'inventory_items': {
        const items = await all(trx, conn, 'inventory_items');
        const need = items.some((i) => i.sold_90d === null || i.sold_90d === undefined);
        const sold = new Map<string, number>();
        if (need) for (const t of await sales()) if (t.occurred_at >= asOf - 90 * DAY) for (const l of t.lines) sold.set(l.offering_id, (sold.get(l.offering_id) ?? 0) + l.qty);
        return items.map((i) => rec(i, {
          id: String(i.id), name: String(i.name), usage: i.usage, on_hand: num(i.on_hand), reserved: num(i.reserved), unit: String(i.unit ?? 'unit'),
          unit_cost_minor: (i.unit_cost as number | null) ?? null, reorder_level: (i.reorder_level as number | null) ?? null, offering_id: str(i.offering_id), location_id: null,
          active: i.active !== false, consumed_90d: num(i.consumed_90d), sold_90d: i.sold_90d === null || i.sold_90d === undefined ? (sold.get(String(i.offering_id)) ?? 0) : num(i.sold_90d),
        } as InventoryItem));
      }
      case 'resources': return (await all(trx, conn, 'resources')).map((r) => rec(r, {
        id: String(r.id), kind: r.kind, type_ref: str(r.type_ref), location_id: null, active: r.active !== false, skills: ((r.skills as string[] | null) ?? []).sort(),
      } as Resource));
      case 'capacity_windows': return (await all(trx, conn, 'capacity_windows')).map((w) => rec(w, { resource_id: String(w.resource_id), start: num(w.start), end: num(w.end), state: w.state } as CapacityWindow));
      case 'transactions': {
        const txs = assembleTransactions(await all(trx, conn, 'transactions'), await all(trx, conn, 'transaction_lines'), m.revenue_basis);
        return txs.map((t) => ({ op: 'upsert' as const, source_id: t.id, source_version: `${t.status}:${t.net_minor}:${t.lines.length}`, data: t }));
      }
      case 'cost_facts': {
        const facts = (await all(trx, conn, 'cost_facts')).map((c) => rec(c, {
          type: c.type, scope: c.scope === 'offering' ? { kind: 'offering', offering_id: String(c.offering_id ?? '') } : c.scope === 'business' ? { kind: 'business' } : { kind: 'category', category: c.scope },
          amount_minor: (c.amount as number | null) ?? null, rate_bp: (c.rate_bp as number | null) ?? null, basis: 'ledger', completeness: c.completeness ?? 'complete',
        } as CostFact));
        // Recorded unit cost of an offering is its material/direct cost unless an explicit fact exists.
        const explicit = new Set(facts.map((f) => f.data as CostFact).filter((f) => f.type === 'material' && f.scope.kind === 'offering').map((f) => (f.scope as { offering_id: string }).offering_id));
        for (const o of await all(trx, conn, 'offerings')) {
          if (explicit.has(String(o.id))) continue;
          const known = typeof o.cost === 'number';
          facts.push({ op: 'upsert', source_id: `recorded:${o.id}`, source_version: String(o.__v), data: {
            type: 'material', scope: { kind: 'offering', offering_id: String(o.id) }, amount_minor: known ? (o.cost as number) : null, rate_bp: null,
            basis: known ? 'recorded_cost' : 'not_tracked', completeness: known ? 'complete' : 'missing',
          } satisfies CostFact });
        }
        return facts;
      }
      case 'demand_signals': return (await all(trx, conn, 'demand_signals')).map((d) => rec(d, {
        type: d.type, offering_id: str(d.offering_id), day: localToMs(String(d.day), '00:00', m.timezone), count: num(d.count, 1), sessions: num(d.sessions),
      } as DemandSignal));
      case 'reviews': return (await all(trx, conn, 'reviews')).map((r) => rec(r, {
        id: String(r.id), rating: num(r.rating), offering_id: str(r.offering_id), resource_id: str(r.resource_id), verified: r.verified !== false, at: num(r.at),
      } as Review));
      case 'customers': {
        const visits = new Map<string, number[]>();
        for (const t of await sales()) visits.set(t.customer_ref, [...(visits.get(t.customer_ref) ?? []), t.occurred_at]);
        return (await all(trx, conn, 'customers')).map((c) => {
          const v = visits.get(String(c.pseudo_id)) ?? [];
          const first = v.length ? Math.min(...v) : null;
          return rec(c, {
            pseudo_id: String(c.pseudo_id), created_at: num(c.created_at, first ?? asOf), first_seen: first, last_seen: v.length ? Math.max(...v) : null, visits: v.length,
            segments: (c.segments as string[] | null) ?? [], acquisition_source: str(c.acquisition_source), consents: { marketing: c.consent_marketing === true }, dup_key: str(c.dup_key),
          } as Customer);
        });
      }
      default:
        return [];
    }
  }

  /** Human description of the stored revenue basis (manifest-equivalent per connection). */
  static revenueBasisText(m: Mapping) { return describeRevenueBasis(m.revenue_basis); }
}
