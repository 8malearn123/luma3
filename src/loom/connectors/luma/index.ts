import type { Selectable } from 'kysely';
import type { DB } from '@/server/db/schema.generated';
import { withTenant, type Tx } from '../../db';
import {
  CANONICAL_ENTITIES, type CanonicalEntity, type CostFact, type InventoryUsage, type OfferingKind, type RequirementType, type ResourceKind,
} from '../../contracts/canonical';
import type { CampaignGroupStat, CampaignGroupStats, ConnectionHealth, ConnectionRef, ConnectorManifest, LoomConnector, PulledRecord, PullResult } from '../../contracts/connector';
import { stableHash } from '../../util/text';
import { addDays, localToday } from '../../util/time';
import { convertQty } from '../../util/units';
import { buildCapacityWindows } from './capacity';
import { freshnessOf, isConsistent, LUMA_REVENUE_BASIS, LUMA_STATUS_MAP, netOf, normalizeStatus, splitNet } from './normalize';

/**
 * The LUMA connector: in-process and read-only. It reads only the
 * loom_export.* views (tenant-scoped, security invoker, RLS applies) inside
 * withTenant(business_id), and returns canonical records.
 *
 * Windows (business-local days): capacity from today−28 to today+13;
 * transactions for 730 days; signals for 120 days (see the views).
 */

const ms = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).getTime());
const n = (x: number | string | null | undefined, d = 0) => (x == null ? d : Number(x));
const ver = (d: Date | string | null | undefined) => String(ms(d) ?? 0);

type Ctx = { trx: Tx; tz: string; now: Date; today: string };

type ExportView = keyof DB & `loom_export.${string}`;
async function rows<T extends ExportView>(trx: Tx, view: T): Promise<Array<Selectable<DB[T]>>> {
  return (await trx.selectFrom(view as ExportView).selectAll().execute()) as unknown as Array<Selectable<DB[T]>>;
}

async function business(c: Ctx): Promise<PulledRecord[]> {
  const b = (await rows(c.trx, 'loom_export.business'))[0];
  if (!b) return [];
  return [{ op: 'upsert', source_id: b.id!, source_version: '1', data: {
    id: b.id!, sector: b.sector ?? 'beauty', subsector: b.subsector, city: b.city, timezone: b.timezone ?? 'Asia/Riyadh', currency: b.currency ?? 'SAR',
    locale: b.locale === 'en' ? 'en' : 'ar', created_at: ms(b.created_at)!,
  } }];
}

async function offerings(c: Ctx): Promise<PulledRecord[]> {
  return (await rows(c.trx, 'loom_export.offerings')).map((o) => ({ op: 'upsert' as const, source_id: o.id!, source_version: ver(o.updated_at), data: {
    id: o.id!, kind: o.kind as OfferingKind, source_kind: o.source_kind!, name: { ar: o.name_ar || o.name_en || '', en: o.name_en || o.name_ar || '' },
    price_minor: n(o.price_minor), status: o.status as 'active', category_id: o.category_id, duration_min: o.duration_min, buffer_min: n(o.buffer_min),
    has_image: !!o.has_image, has_description: !!o.has_description, recorded_cost_minor: o.recorded_cost_minor, visible: !!o.is_visible,
    product_id: o.product_id, location_id: o.location_id,
  } }));
}

async function requirements(c: Ctx): Promise<PulledRecord[]> {
  return (await rows(c.trx, 'loom_export.offering_requirements')).map((r) => ({
    op: 'upsert' as const, source_id: `${r.offering_id}:${r.type}:${r.ref_id ?? '-'}`, source_version: `${r.quantity}:${r.unit}:${r.confidence}`,
    data: { offering_id: r.offering_id!, type: r.type as RequirementType, ref_id: r.ref_id, quantity: n(r.quantity), unit: r.unit!, confidence: r.confidence as 'recipe' },
  }));
}

async function inventory(c: Ctx): Promise<PulledRecord[]> {
  return (await rows(c.trx, 'loom_export.inventory_items')).map((i) => ({ op: 'upsert' as const, source_id: i.id!, source_version: `${ver(i.updated_at)}:${i.on_hand}`, data: {
    id: i.id!, name: i.name!, usage: i.usage as InventoryUsage, on_hand: n(i.on_hand), reserved: n(i.reserved), unit: i.unit!, unit_cost_minor: i.unit_cost_minor,
    reorder_level: i.reorder_level, offering_id: i.offering_id, location_id: i.location_id, active: !!i.is_active, consumed_90d: n(i.consumed_90d), sold_90d: n(i.sold_90d),
  } }));
}

async function resources(c: Ctx): Promise<PulledRecord[]> {
  const res = await rows(c.trx, 'loom_export.resources');
  const skills = await c.trx.selectFrom('loom_export.offering_requirements').select(['offering_id', 'ref_id']).where('type', '=', 'skill').execute();
  return res.map((r) => ({ op: 'upsert' as const, source_id: r.id!, source_version: `${r.is_active}:${r.location_id}`, data: {
    id: r.id!, kind: r.kind as ResourceKind, type_ref: r.resource_type_id, location_id: r.location_id, active: !!r.is_active,
    skills: r.kind === 'staff' ? skills.filter((s) => s.ref_id === r.id).map((s) => s.offering_id!).sort() : [],
  } }));
}

async function capacity(c: Ctx): Promise<PulledRecord[]> {
  const [hours, breaks, overrides, leave, blocks, booked, res] = await Promise.all([
    rows(c.trx, 'loom_export.staff_hours'), rows(c.trx, 'loom_export.staff_breaks'), rows(c.trx, 'loom_export.shift_overrides'),
    rows(c.trx, 'loom_export.staff_leave'), rows(c.trx, 'loom_export.time_blocks'), rows(c.trx, 'loom_export.booked_intervals'),
    c.trx.selectFrom('loom_export.resources').select(['id']).where('kind', '=', 'staff').where('is_active', '=', true).execute(),
  ]);
  const windows = buildCapacityWindows({
    hours: hours.map((h) => ({ resource_id: h.resource_id!, weekday: n(h.weekday), start_time: h.start_time!, end_time: h.end_time!, effective_from: h.effective_from, effective_to: h.effective_to, timezone: h.timezone ?? c.tz })),
    breaks: breaks.map((b) => ({ resource_id: b.resource_id!, weekday: b.weekday, on_date: b.on_date, start_time: b.start_time!, end_time: b.end_time! })),
    overrides: overrides.map((o) => ({ resource_id: o.resource_id!, on_date: o.on_date!, kind: o.kind!, start_time: o.start_time, end_time: o.end_time, timezone: o.timezone ?? c.tz })),
    leave: leave.map((l) => ({ resource_id: l.resource_id!, start: ms(l.starts_at), end: ms(l.ends_at) })),
    blocks: blocks.filter((b) => b.is_staff).map((b) => ({ resource_id: b.resource_id!, start: ms(b.starts_at), end: ms(b.ends_at) })),
    booked: booked.map((b) => ({ resource_id: b.resource_id!, start: ms(b.starts_at)!, end: ms(b.ends_at)! })),
  }, res.map((r) => r.id!).sort(), c.tz, addDays(c.today, -28), addDays(c.today, 13));
  return windows.map((w) => ({ op: 'upsert' as const, source_id: `${w.resource_id}:${w.start}:${w.state}`, source_version: String(w.end), data: w }));
}

async function transactions(c: Ctx): Promise<PulledRecord[]> {
  const [tx, lines, fees] = await Promise.all([
    rows(c.trx, 'loom_export.transactions'), rows(c.trx, 'loom_export.transaction_lines'), rows(c.trx, 'loom_export.payment_fees'),
  ]);
  const byTx = new Map<string, typeof lines>();
  for (const l of lines) { const a = byTx.get(l.transaction_id!) ?? []; a.push(l); byTx.set(l.transaction_id!, a); }
  const feeBy = new Map(fees.map((f) => [f.transaction_id!, n(f.platform_fee_minor)]));
  return tx.map((t) => {
    const kind = t.kind === 'order' ? 'order' : 'booking';
    const status = normalizeStatus(kind, t.source_status!, t.cancel_source);
    const amounts = { total_minor: n(t.total_minor), tax_minor: n(t.tax_minor), refunded_minor: n(t.refunded_minor), subtotal_minor: n(t.subtotal_minor) };
    const ls = (byTx.get(t.id!) ?? []).sort((a, b) => a.id!.localeCompare(b.id!));
    const net = netOf(amounts);
    const shares = splitNet(net, ls.map((l) => n(l.line_total_minor)));
    return { op: 'upsert' as const, source_id: t.id!, source_version: ver(t.updated_at), data: {
      id: t.id!, kind, status, source_status: t.source_status!, channel: t.channel ?? 'direct', origin: t.origin, customer_ref: t.customer_ref!,
      gross_minor: amounts.subtotal_minor, discount_minor: n(t.discount_minor), tax_minor: amounts.tax_minor, total_minor: amounts.total_minor,
      refunded_minor: amounts.refunded_minor, net_minor: net, occurred_at: ms(t.occurred_at)!, campaign_id: t.campaign_id, has_coupon: !!t.has_coupon,
      platform_fee_minor: Math.max(n(t.platform_fee_minor), feeBy.get(t.id!) ?? 0),
      lines: ls.map((l, i) => ({
        id: l.id!, offering_id: l.offering_id!, resource_ids: l.resource_id ? [l.resource_id] : [], qty: n(l.qty, 1), net_minor: shares[i] ?? 0,
        line_total_minor: n(l.line_total_minor), cost_direct_minor: l.unit_cost_minor == null ? null : n(l.unit_cost_minor) * n(l.qty, 1),
        starts_at: ms(l.starts_at)!, duration_min: l.duration_min,
      })),
      consistent: isConsistent({ ...amounts, status }, ls.map((l) => n(l.line_total_minor))),
    } };
  });
}

/**
 * Cost facts: material per offering (complete approved recipe with costed
 * items > recorded cost > missing), commission per payroll policy category
 * (enabled: highest of base rate, tiers and staff overrides — conservative),
 * marketplace platform fee from the ledger, payment processing fee not tracked.
 */
async function costFacts(c: Ctx): Promise<PulledRecord[]> {
  const [offs, reqs, items, pol] = await Promise.all([
    rows(c.trx, 'loom_export.offerings'), rows(c.trx, 'loom_export.offering_requirements'), rows(c.trx, 'loom_export.inventory_items'), rows(c.trx, 'loom_export.commission_policies'),
  ]);
  const itemBy = new Map(items.map((i) => [i.id!, i]));
  const facts: CostFact[] = [];
  for (const o of offs) {
    if (o.kind !== 'service' && o.kind !== 'product') continue;
    const recipe = reqs.filter((r) => r.offering_id === o.id && r.type === 'material');
    let recipeCost: number | null = null;
    if (recipe.length && recipe.every((r) => r.confidence === 'recipe')) {
      let total = 0;
      for (const r of recipe) {
        const it = itemBy.get(r.ref_id!);
        const q = it ? convertQty(n(r.quantity), r.unit!, it.unit!) : null;
        if (!it || it.unit_cost_minor == null || q === null) { total = NaN; break; }
        total += q * n(it.unit_cost_minor);
      }
      if (Number.isFinite(total)) recipeCost = Math.round(total);
    }
    const scope = { kind: 'offering' as const, offering_id: o.id! };
    if (recipeCost !== null) facts.push({ type: 'material', scope, amount_minor: recipeCost, rate_bp: null, basis: 'recipe', completeness: 'complete' });
    else if (o.recorded_cost_minor != null) facts.push({ type: 'material', scope, amount_minor: n(o.recorded_cost_minor), rate_bp: null, basis: 'recorded_cost', completeness: 'complete' });
    else facts.push({ type: 'material', scope, amount_minor: null, rate_bp: null, basis: 'recorded_cost', completeness: 'missing' });
  }
  for (const category of ['services', 'products'] as const) {
    const p = pol.find((x) => x.category === category);
    const tiers = Array.isArray(p?.tiers) ? (p!.tiers as Array<{ rate_bp?: number }>) : [];
    const rate = p?.enabled ? Math.max(n(p.rate_bp), ...tiers.map((t) => n(t.rate_bp)), n(p.max_override_bp)) : 0;
    facts.push({ type: 'commission', scope: { kind: 'category', category }, amount_minor: null, rate_bp: rate, basis: 'policy', completeness: 'complete' });
  }
  facts.push({ type: 'platform_fee', scope: { kind: 'business' }, amount_minor: null, rate_bp: null, basis: 'ledger', completeness: 'complete' });
  facts.push({ type: 'payment_fee', scope: { kind: 'business' }, amount_minor: null, rate_bp: null, basis: 'not_tracked', completeness: 'partial',
    note: { ar: 'رسوم معالجة الدفع غير مسجلة في لوما؛ لم تُطرح من الهامش.', en: 'Payment processing fees are not recorded in LUMA; they are not deducted from margins.' } });
  return facts.map((f) => ({ op: 'upsert' as const, source_id: `${f.type}:${f.scope.kind === 'offering' ? f.scope.offering_id : f.scope.kind === 'category' ? f.scope.category : 'business'}`, source_version: stableHash(f).slice(0, 16), data: f }));
}

async function demand(c: Ctx): Promise<PulledRecord[]> {
  return (await rows(c.trx, 'loom_export.demand_signals')).filter((d) => d.type).map((d) => ({
    op: 'upsert' as const, source_id: `${d.type}:${d.offering_id ?? '-'}:${ms(d.day)}`, source_version: `${d.events}:${d.sessions}`,
    data: { type: d.type, offering_id: d.offering_id, day: ms(d.day)!, count: n(d.events), sessions: n(d.sessions) },
  }));
}

async function simple(c: Ctx, entity: CanonicalEntity): Promise<PulledRecord[]> {
  const now = c.now.getTime();
  switch (entity) {
    case 'locations': return (await rows(c.trx, 'loom_export.locations')).map((l) => ({ op: 'upsert' as const, source_id: l.id!, source_version: `${l.status}`, data: { id: l.id!, name: l.name!, city: l.city, timezone: l.timezone ?? c.tz, active: l.status === 'active' } }));
    case 'reviews': return (await rows(c.trx, 'loom_export.reviews')).map((r) => ({ op: 'upsert' as const, source_id: r.id!, source_version: '1', data: { id: r.id!, rating: n(r.rating), offering_id: r.offering_id, resource_id: r.resource_id, verified: !!r.verified, at: ms(r.at)! } }));
    case 'complaints': return (await rows(c.trx, 'loom_export.complaints')).map((r) => ({ op: 'upsert' as const, source_id: r.id!, source_version: String(r.verified), data: { id: r.id!, verified: !!r.verified, offering_id: r.offering_id, at: ms(r.at)! } }));
    case 'customers': return (await rows(c.trx, 'loom_export.customers')).map((r) => {
      const consents = Object.fromEntries(Object.entries((r.consents ?? {}) as Record<string, boolean>).map(([k, v]) => [k === 'push' ? 'in_app' : k, !!v]));
      return { op: 'upsert' as const, source_id: r.ref!, source_version: ver(r.updated_at), data: {
        pseudo_id: r.ref!, created_at: ms(r.created_at)!, first_seen: ms(r.first_visit_at), last_seen: ms(r.last_visit_at), visits: n(r.visits),
        segments: [], acquisition_source: r.acquisition_source, consents, dup_key: r.dup_key,
      } };
    });
    case 'campaigns': return (await rows(c.trx, 'loom_export.campaigns')).map((r) => ({ op: 'upsert' as const, source_id: r.id!, source_version: `${r.status}:${r.targeted}:${r.conversions}`, data: {
      id: r.id!, channel: r.channel!, status: r.status!, holdout_bp: n(r.holdout_bp), started_at: ms(r.started_at), finished_at: ms(r.finished_at),
      targeted: n(r.targeted), holdout: n(r.holdout), conversions: n(r.conversions), attributed_net_minor: n(r.attributed_net_minor), cost_minor: null,
    } }));
    case 'calendar_events': return (await rows(c.trx, 'loom_export.calendar_events')).map((r) => ({ op: 'upsert' as const, source_id: r.id!, source_version: `${r.starts_on}:${r.ends_on}`, data: {
      id: r.id!, title: r.title!, kind: r.kind!, starts_on: r.starts_on!, ends_on: r.ends_on!, verified: true, has_source: !!r.has_source,
    } }));
    case 'market_signals': return (await rows(c.trx, 'loom_export.market_signals')).map((r) => ({ op: 'upsert' as const, source_id: r.id!, source_version: r.evidence_strength ?? '', data: {
      id: r.id!, title: r.title!, topic: r.topic, published_at: ms(r.published_at), observed_at: ms(r.observed_at)!, evidence_strength: r.evidence_strength!, freshness: freshnessOf(ms(r.published_at), now),
    } }));
    case 'host_preferences': {
      const p = (await rows(c.trx, 'loom_export.marketing_preferences'))[0];
      if (!p) return [];
      return [{ op: 'upsert', source_id: 'marketing_preferences', source_version: ver(p.updated_at), data: {
        max_discount_bp: p.max_discount_bp, monthly_budget_minor: p.monthly_budget_minor, goals: Array.isArray(p.goals) ? (p.goals as string[]) : [], tone: p.tone, channels: p.channels ?? [],
      } }];
    }
    default: return [];
  }
}

const PULLERS: Record<CanonicalEntity, (c: Ctx) => Promise<PulledRecord[]>> = {
  business, offerings, offering_requirements: requirements, inventory_items: inventory, resources, capacity_windows: capacity, transactions,
  cost_facts: costFacts, demand_signals: demand,
  locations: (c) => simple(c, 'locations'), reviews: (c) => simple(c, 'reviews'), complaints: (c) => simple(c, 'complaints'),
  customers: (c) => simple(c, 'customers'), campaigns: (c) => simple(c, 'campaigns'), calendar_events: (c) => simple(c, 'calendar_events'),
  market_signals: (c) => simple(c, 'market_signals'), host_preferences: (c) => simple(c, 'host_preferences'),
};

export const LUMA_CONNECTOR_VERSION = 'luma-1';

export class LumaConnector implements LoomConnector {
  readonly kind = 'luma';

  describe(): ConnectorManifest {
    return {
      kind: 'luma', version: LUMA_CONNECTOR_VERSION,
      entities: CANONICAL_ENTITIES.map((entity) => ({ entity, fields: [], incremental: false })),
      revenue_basis: LUMA_REVENUE_BASIS,
      status_map: LUMA_STATUS_MAP as unknown as ConnectorManifest['status_map'],
      timezone_source: 'tenants.timezone (business); branches.timezone (working hours)',
    };
  }

  async healthcheck(conn: ConnectionRef): Promise<ConnectionHealth> {
    try {
      const b = await withTenant(conn.business_id, (trx) => trx.selectFrom('loom_export.business').select('id').executeTakeFirst());
      return { status: b ? 'ok' : 'down', checked_at: new Date().toISOString(), detail: b ? undefined : 'business_not_visible' };
    } catch (e) {
      return { status: 'down', checked_at: new Date().toISOString(), detail: (e as Error).message };
    }
  }

  /** Campaign target / holdout groups (loom_export.campaign_groups, migration 0730). */
  async campaignGroups(conn: ConnectionRef, campaignId: string): Promise<CampaignGroupStats | null> {
    const rows = await withTenant(conn.business_id, (trx) => trx.selectFrom('loom_export.campaign_groups').selectAll().where('campaign_id', '=', campaignId).execute());
    if (!rows.length) return null;
    const g = (name: string): CampaignGroupStat | null => {
      const r = rows.find((x) => x.grp === name);
      return r ? { members: n(r.members), converters: n(r.converters), bookings: n(r.bookings), net_minor: n(r.net_minor), cancelled: n(r.cancelled), refunded_minor: n(r.refunded_minor) } : null;
    };
    return { campaign_id: campaignId, window_days: n(rows[0]!.attribution_window_days) || 14, started_at: ms(rows[0]!.started_at), target: g('target'), holdout: g('holdout') };
  }

  /** Reads the whole entity in one tenant transaction and pages by offset (the views are already windowed). */
  async pull(conn: ConnectionRef, entity: CanonicalEntity, cursor: string | null, limit: number): Promise<PullResult> {
    const now = conn.as_of ?? new Date();
    const all = await withTenant(conn.business_id, async (trx) => {
      const b = await trx.selectFrom('loom_export.business').select(['timezone']).executeTakeFirst();
      const tz = b?.timezone ?? 'Asia/Riyadh';
      const recs = await PULLERS[entity]({ trx, tz, now, today: localToday(tz, now) });
      return recs.sort((a, b2) => (a.source_id < b2.source_id ? -1 : a.source_id > b2.source_id ? 1 : 0));
    });
    const offset = cursor ? Number(cursor) : 0;
    const page = all.slice(offset, offset + limit);
    return { records: page, next_cursor: offset + limit < all.length ? String(offset + limit) : null };
  }
}
