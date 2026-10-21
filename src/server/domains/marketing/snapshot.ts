import { createHash } from 'node:crypto';
import { sql, type Tx } from '../../db/client';
import { funnelTotals, rates, serviceDemand } from '../analytics/metrics';
import { computeOccupancy, type Daypart } from '../analytics/occupancy';
import { addDays, localToday, resolvePeriod, weekdayOf } from '../analytics/period';

/**
 * Trusted metric snapshot (§29 step 2). Every number the adviser may cite is
 * computed here by SQL/code and stored with its period, data_as_of and a
 * content hash. The AI only interprets these values; validation checks every
 * numeric claim against `metrics`.
 *
 * Privacy: no customer names, phones, emails or staff names; services are
 * referenced as svc_N (ids stay server-side); trend text is untrusted data.
 */

export type MetricValue = { value: number | null; unit: 'count' | 'ratio' | 'minor' | 'minutes' | 'rating' | 'days'; label: string };
export type SnapshotService = {
  ref: string; id: string; name: string; price_minor: number; duration_min: number;
  cost_status: 'known' | 'missing'; margin_ratio: number | null; has_image: boolean; has_description: boolean;
  demand: { views: number; booking_starts: number; availability_empty: number; waitlist: number; confirmed: number; completed: number; cancelled: number };
  satisfaction: { avg: number | null; n: number };
  cadence_days: number | null; cadence_n: number; due_customers: number;
};
export type SnapshotData = {
  version: 1;
  business: { type: string; city: string | null; timezone: string; currency: string; locale: 'ar' | 'en' };
  period: { from: string; to: string; lookback_from: string; today: string };
  data_as_of: string;
  metrics: Record<string, MetricValue>;
  services: SnapshotService[];
  capacity: {
    next_days: Array<{ date: string; weekday: number; available_min: number; booked_min: number; free_min: number }>;
    buckets: Array<{ key: string; weekday: number; daypart: Daypart; occupancy: number; available_min: number }>;
  };
  pairs: Array<{ a: string; b: string; customers: number }>;
  customers: { total: number; active_90d: number; inactive_90d: number; consented: Record<string, number> };
  preferences: {
    goals: string[]; monthly_budget_minor: number | null; max_discount_bp: number; tone: string | null; brand_style: string | null;
    channels: string[]; audience_notes: string | null; photography_resources: string | null; promote_products: boolean;
  };
  calendar: { source: 'owner_verified' | 'none'; events: Array<{ title: string; kind: string; starts_on: string; ends_on: string; relevance_note: string | null }> };
  campaigns: Array<{ ref: string; channel: string; status: string; targeted: number; conversions: number; attributed_net_minor: number }>;
  prior_decisions: Array<{ category: string; title: string; status: string }>;
  trends: Array<{ ref: string; id: string; title: string; summary: string | null; source: string; published_at: string | null; evidence_strength: string; freshness: 'fresh' | 'aging' | 'stale' | 'unknown' }>;
  sufficiency: { level: 'none' | 'low' | 'ok'; completed_90d: number; active_services: number; scheduled_min_next: number; sessions_30d: number; missing: string[] };
};

export function canonicalHash(v: unknown): string {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm)
    : x && typeof x === 'object' && !(x instanceof Date) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x;
  return createHash('sha256').update(JSON.stringify(norm(v))).digest('hex');
}

export function freshnessOf(published: Date | null, now = Date.now()): 'fresh' | 'aging' | 'stale' | 'unknown' {
  if (!published) return 'unknown';
  const days = (now - published.getTime()) / 86_400_000;
  return days <= 14 ? 'fresh' : days <= 45 ? 'aging' : 'stale';
}

/** SQL fragment: per (customer, service) last completed visit + per-service median cadence. Shared with segments. */
export const cadenceCte = (tenantId: string) => sql`
  visits as (
    select bk.tenant_customer_id as c, bi.service_id as s, bi.starts_at as t
    from booking_items bi join bookings bk on bk.id = bi.booking_id and bk.tenant_id = bi.tenant_id
    where bi.tenant_id = ${tenantId} and bk.status = 'completed' and bi.starts_at > now() - interval '730 days'
  ),
  gaps as (
    select s, extract(epoch from (t - lag(t) over (partition by c, s order by t))) / 86400.0 as gap from visits
  ),
  cadence as (
    select s, percentile_cont(0.5) within group (order by gap) as days, count(*)::int as n from gaps where gap is not null and gap >= 1 group by s
  ),
  last_visit as (select c, s, max(t) as last_t from visits group by c, s),
  future as (
    select distinct bk.tenant_customer_id as c from bookings bk
    where bk.tenant_id = ${tenantId} and bk.starts_at > now() and bk.status in ('pending_approval', 'pending_payment', 'confirmed')
  ),
  due as (
    select lv.c, lv.s from last_visit lv join cadence cd on cd.s = lv.s
    where cd.n >= 3 and lv.last_t < now() - make_interval(secs => (cd.days * 1.5 * 86400)::int)
      and not exists (select 1 from future f where f.c = lv.c)
  )`;

export async function buildSnapshot(trx: Tx, tenantId: string, opts: { kind: string; from: string; to: string; now?: Date }): Promise<{ id: string; data: SnapshotData; hash: string; reused: boolean }> {
  const now = opts.now ?? new Date();
  const tenant = await trx.selectFrom('tenants').select(['business_type', 'city', 'timezone', 'currency', 'default_locale']).where('id', '=', tenantId).executeTakeFirstOrThrow();
  const tz = tenant.timezone;
  const locale = tenant.default_locale === 'en' ? 'en' : 'ar';
  const today = localToday(tz, now);
  const lookbackFrom = addDays(today, -90);
  const p90 = resolvePeriod(tz, lookbackFrom, addDays(today, -1));
  const p30 = resolvePeriod(tz, addDays(today, -30), addDays(today, -1));
  const metrics: Record<string, MetricValue> = {};
  const put = (key: string, value: number | null, unit: MetricValue['unit'], label: string) => { metrics[key] = { value: value === null ? null : Math.round(value * 10000) / 10000, unit, label }; };

  // ── Services, demand (separate signals), satisfaction, margins, cadence ──
  const demand = await serviceDemand(trx, tenantId, p30.start, p30.end);
  const svcMeta = await trx.selectFrom('services').select(['id', 'image_asset_id', 'description_ar', 'description_en', 'is_active', 'is_visible'])
    .where('tenant_id', '=', tenantId).where('archived_at', 'is', null).execute();
  const metaById = new Map(svcMeta.map((s) => [s.id, s]));
  const sat = await sql<{ service_id: string; avg: number; n: number }>`
    select bi.service_id, avg(r.rating)::float8 as avg, count(*)::int as n from reviews r
    join booking_items bi on bi.booking_id = r.booking_id and bi.tenant_id = r.tenant_id
    where r.tenant_id = ${tenantId} and r.status <> 'hidden' and r.created_at > now() - interval '365 days' group by bi.service_id`.execute(trx);
  const satById = new Map(sat.rows.map((r) => [r.service_id, r]));
  const cad = await sql<{ s: string; days: number | null; n: number; due: number }>`
    with ${cadenceCte(tenantId)}
    select cd.s, cd.days::float8 as days, cd.n, (select count(*) from due where due.s = cd.s)::int as due from cadence cd`.execute(trx);
  const cadById = new Map(cad.rows.map((r) => [r.s, r]));

  const services: SnapshotService[] = demand
    .filter((d) => metaById.get(d.service_id)?.is_active)
    .map((d, i) => {
      const meta = metaById.get(d.service_id)!;
      const sr = satById.get(d.service_id);
      const c = cadById.get(d.service_id);
      const ref = `svc_${i + 1}`;
      const margin = d.cost_minor !== null && d.price_minor > 0 ? (d.price_minor - d.cost_minor) / d.price_minor : null;
      const s: SnapshotService = {
        ref, id: d.service_id, name: (locale === 'ar' ? d.name_ar || d.name_en : d.name_en || d.name_ar) ?? ref,
        price_minor: d.price_minor, duration_min: d.duration_min,
        cost_status: d.cost_minor === null ? 'missing' : 'known', margin_ratio: margin,
        has_image: !!meta.image_asset_id, has_description: !!(meta.description_ar || meta.description_en),
        demand: { views: d.views, booking_starts: d.booking_starts, availability_empty: d.availability_empty, waitlist: d.waitlist_entries + d.waitlist_events, confirmed: d.confirmed, completed: d.completed, cancelled: d.cancelled },
        satisfaction: { avg: sr?.avg ?? null, n: sr?.n ?? 0 },
        cadence_days: c && c.n >= 3 ? c.days : null, cadence_n: c?.n ?? 0, due_customers: c && c.n >= 3 ? c.due : 0,
      };
      put(`service.${ref}.price_minor`, s.price_minor, 'minor', `${s.name}: price`);
      put(`service.${ref}.margin_ratio`, margin, 'ratio', `${s.name}: gross margin (price − recorded cost)`);
      put(`service.${ref}.views_30d`, s.demand.views, 'count', `${s.name}: storefront views (30d)`);
      put(`service.${ref}.booking_starts_30d`, s.demand.booking_starts, 'count', `${s.name}: booking starts (30d)`);
      put(`service.${ref}.availability_empty_30d`, s.demand.availability_empty, 'count', `${s.name}: no-availability moments (30d)`);
      put(`service.${ref}.waitlist_30d`, s.demand.waitlist, 'count', `${s.name}: waitlist demand (30d)`);
      put(`service.${ref}.confirmed_30d`, s.demand.confirmed, 'count', `${s.name}: confirmed bookings (30d)`);
      put(`service.${ref}.completed_30d`, s.demand.completed, 'count', `${s.name}: completed bookings (30d)`);
      put(`service.${ref}.satisfaction_avg`, s.satisfaction.avg, 'rating', `${s.name}: average rating`);
      put(`service.${ref}.satisfaction_n`, s.satisfaction.n, 'count', `${s.name}: number of reviews`);
      put(`service.${ref}.cadence_days`, s.cadence_days, 'days', `${s.name}: median days between repeat visits`);
      put(`service.${ref}.due_customers`, s.due_customers, 'count', `${s.name}: customers past their usual return interval`);
      return s;
    });

  // Pairs of services the same customers book (cross-sell/packages evidence).
  const pairRows = await sql<{ a: string; b: string; customers: number }>`
    with v as (
      select distinct bk.tenant_customer_id as c, bi.service_id as s from booking_items bi join bookings bk on bk.id = bi.booking_id and bk.tenant_id = bi.tenant_id
      where bi.tenant_id = ${tenantId} and bk.status = 'completed' and bi.starts_at > now() - interval '180 days'
    )
    select x.s as a, y.s as b, count(*)::int as customers from v x join v y on x.c = y.c and x.s < y.s group by 1, 2 having count(*) >= 2 order by 3 desc limit 5`.execute(trx);
  const refById = new Map(services.map((s) => [s.id, s.ref]));
  const pairs = pairRows.rows.filter((p) => refById.has(p.a) && refById.has(p.b)).map((p) => ({ a: refById.get(p.a)!, b: refById.get(p.b)!, customers: p.customers }));
  for (const p of pairs) put(`pair.${p.a}.${p.b}.customers`, p.customers, 'count', `Customers who booked both ${p.a} and ${p.b} (180d)`);

  // ── Capacity: past 28 days by weekday/daypart, next 14 days free time ──
  const past = await computeOccupancy(trx, tenantId, tz, addDays(today, -28), addDays(today, -1));
  const buckets = past.buckets.map((b) => ({ key: `bucket.${b.weekday}.${b.daypart}.occupancy`, weekday: b.weekday, daypart: b.daypart, occupancy: b.occupancy ?? 0, available_min: b.available_min }));
  for (const b of buckets) put(b.key, b.occupancy, 'ratio', `Occupancy, weekday ${b.weekday} ${b.daypart} (last 28d)`);
  put('capacity.past28.occupancy', past.totals.occupancy, 'ratio', 'Occupancy, last 28 days');
  put('capacity.past28.available_min', past.totals.available_min, 'minutes', 'Available working minutes, last 28 days');
  const future = await computeOccupancy(trx, tenantId, tz, today, addDays(today, 13));
  const nextDays = new Map<string, { available_min: number; booked_min: number }>();
  for (const s of future.staff) for (const d of s.days) {
    const cur = nextDays.get(d.date) ?? { available_min: 0, booked_min: 0 };
    nextDays.set(d.date, { available_min: cur.available_min + d.available_min, booked_min: cur.booked_min + d.booked_min });
  }
  const next_days = [...nextDays].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, weekday: weekdayOf(date), ...v, free_min: Math.max(0, v.available_min - v.booked_min) }));
  for (const d of next_days) put(`capacity.day.${d.date}.free_min`, d.free_min, 'minutes', `Free bookable minutes on ${d.date}`);
  const freeNext = next_days.reduce((m, d) => m + d.free_min, 0);
  put('capacity.next14.free_min', freeNext, 'minutes', 'Free bookable minutes, next 14 days');
  put('capacity.next14.occupancy', future.totals.occupancy, 'ratio', 'Already-booked share of the next 14 days');

  // ── Bookings, customers, storefront ──
  const bk = await sql<{ completed: number; cancelled: number; no_show: number; net_minor: number; customers: number }>`
    select count(*) filter (where status = 'completed')::int as completed, count(*) filter (where status = 'cancelled')::int as cancelled,
           count(*) filter (where status = 'no_show')::int as no_show,
           coalesce(sum(total_minor - refunded_minor) filter (where status = 'completed'), 0)::bigint as net_minor,
           count(distinct tenant_customer_id) filter (where status = 'completed')::int as customers
    from bookings where tenant_id = ${tenantId} and starts_at >= ${p90.start} and starts_at < ${p90.end}`.execute(trx);
  const b = bk.rows[0]!;
  put('bookings.completed_90d', b.completed, 'count', 'Completed bookings (90d)');
  put('bookings.cancelled_90d', b.cancelled, 'count', 'Cancelled bookings (90d)');
  put('bookings.no_show_90d', b.no_show, 'count', 'No-shows (90d)');
  put('bookings.net_revenue_90d_minor', b.net_minor, 'minor', 'Completed booking value net of refunds (90d)');
  put('bookings.cancellation_rate_90d', b.completed + b.cancelled > 0 ? b.cancelled / (b.completed + b.cancelled) : null, 'ratio', 'Cancellation share (90d)');

  const cust = await sql<{ total: number; active: number; repeaters: number }>`
    with last as (
      select tenant_customer_id as c, max(starts_at) as t, count(*) as n from bookings where tenant_id = ${tenantId} and status = 'completed' group by 1
    )
    select (select count(*) from tenant_customers where tenant_id = ${tenantId} and status = 'active')::int as total,
           (select count(*) from last where t > now() - interval '90 days')::int as active,
           (select count(*) from last where n >= 2)::int as repeaters`.execute(trx);
  const cu = cust.rows[0]!;
  const consent = await sql<{ channel: string; n: number }>`
    select channel, count(*)::int as n from (
      select distinct on (coalesce(tenant_customer_id::text, user_id::text), channel) channel, granted
      from customer_consents where tenant_id = ${tenantId} and purpose = 'marketing'
      order by coalesce(tenant_customer_id::text, user_id::text), channel, recorded_at desc
    ) x where granted group by channel`.execute(trx);
  const consented = Object.fromEntries(consent.rows.map((r) => [r.channel === 'push' ? 'in_app' : r.channel, r.n]));
  put('customers.total', cu.total, 'count', 'Customers on record');
  put('customers.active_90d', cu.active, 'count', 'Customers with a completed visit in the last 90 days');
  put('customers.inactive_90d', Math.max(0, cu.total - cu.active), 'count', 'Customers without a visit in 90 days');
  put('customers.repeat_share', cu.total > 0 ? cu.repeaters / cu.total : null, 'ratio', 'Share of customers with 2+ completed visits');
  for (const [ch, n] of Object.entries(consented)) put(`customers.consented.${ch}`, n, 'count', `Customers with marketing consent (${ch})`);

  const sf = await funnelTotals(trx, tenantId, p30.start, p30.end);
  const sr = rates(sf);
  put('storefront.sessions_30d', sf.sessions, 'count', 'Storefront sessions (30d)');
  put('storefront.conversion_rate_30d', sr.conversion_rate, 'ratio', 'Sessions with a booking or paid order ÷ sessions (30d)');
  put('storefront.booking_starts_30d', sf.booking_starts, 'count', 'Booking starts (30d)');
  put('storefront.availability_empty_30d', sf.availability_empty, 'count', 'Times a visitor found no availability (30d)');
  put('storefront.start_to_confirm_30d', sf.booking_starts > 0 ? sf.session_bookings / sf.booking_starts : null, 'ratio', 'Session-linked bookings ÷ booking starts (30d)');

  const stock = await sql<{ low: number }>`select count(*)::int as low from inventory_items where tenant_id = ${tenantId} and is_active
    and low_stock_threshold is not null and on_hand <= low_stock_threshold`.execute(trx);
  put('stock.low_items', stock.rows[0]!.low, 'count', 'Inventory items at or below their low-stock threshold');

  // ── Preferences, verified calendar, campaigns, decisions, trends ──
  const pref = await trx.selectFrom('marketing_preferences').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
  const preferences: SnapshotData['preferences'] = {
    goals: (pref?.goals as string[] | undefined) ?? [], monthly_budget_minor: pref?.monthly_budget_minor ?? null, max_discount_bp: pref?.max_discount_bp ?? 2000,
    tone: pref?.tone ?? null, brand_style: pref?.brand_style ?? null, channels: pref?.channels ?? [], audience_notes: pref?.audience_notes ?? null,
    photography_resources: pref?.photography_resources ?? null, promote_products: pref?.promote_products ?? true,
  };
  put('preferences.max_discount_bp', preferences.max_discount_bp, 'count', 'Maximum discount allowed (basis points)');
  put('preferences.monthly_budget_minor', preferences.monthly_budget_minor, 'minor', 'Monthly marketing budget');
  const cal = await trx.selectFrom('marketing_calendar_events').select(['title', 'kind', 'starts_on', 'ends_on', 'relevance_note'])
    .where('tenant_id', '=', tenantId).where('ends_on', '>=', opts.from).where('starts_on', '<=', addDays(opts.to, 30)).orderBy('starts_on').limit(20).execute();
  const anyCal = await trx.selectFrom('marketing_calendar_events').select('id').where('tenant_id', '=', tenantId).limit(1).executeTakeFirst();

  const camp = await sql<{ id: string; channel: string; status: string; targeted: number; conversions: number; net: number }>`
    select c.id, c.channel, c.status,
      (select count(*) from campaign_events e where e.campaign_id = c.id and e.kind in ('sent', 'simulated'))::int as targeted,
      (select count(*) from campaign_events e where e.campaign_id = c.id and e.kind = 'converted')::int as conversions,
      (select coalesce(sum(value_minor), 0) from campaign_events e where e.campaign_id = c.id and e.kind = 'converted')::bigint as net
    from campaigns c where c.tenant_id = ${tenantId} and c.status in ('sent', 'completed', 'sending') order by c.created_at desc limit 5`.execute(trx);
  const campaigns = camp.rows.map((c, i) => ({ ref: `cmp_${i + 1}`, channel: c.channel, status: c.status, targeted: c.targeted, conversions: c.conversions, attributed_net_minor: c.net }));
  for (const c of campaigns) {
    put(`campaign.${c.ref}.targeted`, c.targeted, 'count', `Campaign ${c.ref}: messages delivered or simulated`);
    put(`campaign.${c.ref}.conversions`, c.conversions, 'count', `Campaign ${c.ref}: attributed completed bookings`);
  }
  const decisions = await trx.selectFrom('recommendations').select(['category', 'title', 'status'])
    .where('tenant_id', '=', tenantId).where('status', 'in', ['accepted', 'dismissed', 'deferred']).where('decided_at', '>', new Date(now.getTime() - 90 * 86_400_000))
    .orderBy('decided_at', 'desc').limit(15).execute();
  const tr = await trx.selectFrom('trend_observations as o').leftJoin('trend_sources as s', 's.id', 'o.source_id')
    .select(['o.id', 'o.title', 'o.summary', 'o.published_at', 'o.evidence_strength', 's.name as source_name'])
    .where('o.tenant_id', '=', tenantId).where('o.observed_at', '>', new Date(now.getTime() - 60 * 86_400_000))
    .orderBy('o.published_at', 'desc').limit(10).execute();
  const trends = tr.map((t, i) => ({
    ref: `tr_${i + 1}`, id: t.id, title: t.title.slice(0, 200), summary: t.summary?.slice(0, 400) ?? null, source: t.source_name ?? 'unknown',
    published_at: t.published_at?.toISOString() ?? null, evidence_strength: t.evidence_strength, freshness: freshnessOf(t.published_at, now.getTime()),
  }));
  for (const t of trends) put(`trend.${t.ref}`, null, 'count', `Trend observation ${t.ref} (${t.evidence_strength}, ${t.freshness})`);

  // ── Sufficiency ──
  const missing: string[] = [];
  if (!services.length) missing.push('active_services');
  if (past.totals.available_min === 0 && future.totals.available_min === 0) missing.push('working_schedule');
  if (b.completed < 10) missing.push('booking_history');
  if (services.some((s) => s.cost_status === 'missing')) missing.push('service_costs');
  if (!anyCal) missing.push('verified_calendar');
  if (!trends.length) missing.push('trend_sources');
  if (sf.sessions < 30) missing.push('storefront_traffic');
  const level: SnapshotData['sufficiency']['level'] = !services.length || (b.completed === 0 && sf.sessions < 10 && future.totals.available_min === 0) ? 'none'
    : b.completed < 20 ? 'low' : 'ok';

  const data: SnapshotData = {
    version: 1,
    business: { type: tenant.business_type, city: tenant.city, timezone: tz, currency: tenant.currency, locale },
    period: { from: opts.from, to: opts.to, lookback_from: lookbackFrom, today },
    data_as_of: now.toISOString(),
    metrics, services, capacity: { next_days, buckets }, pairs,
    customers: { total: cu.total, active_90d: cu.active, inactive_90d: Math.max(0, cu.total - cu.active), consented },
    preferences,
    calendar: { source: anyCal ? 'owner_verified' : 'none', events: cal.map((c) => ({ ...c, relevance_note: c.relevance_note ?? null })) },
    campaigns, prior_decisions: decisions, trends,
    sufficiency: { level, completed_90d: b.completed, active_services: services.length, scheduled_min_next: future.totals.available_min, sessions_30d: sf.sessions, missing },
  };
  // Hash excludes the as-of instant so an unchanged business reuses the snapshot (and the AI cache).
  const hash = canonicalHash({ ...data, data_as_of: null });
  const existing = await trx.selectFrom('metric_snapshots').select(['id']).where('tenant_id', '=', tenantId).where('kind', '=', opts.kind)
    .where('content_hash', '=', hash).where('period_start', '=', opts.from).where('period_end', '=', opts.to).executeTakeFirst();
  if (existing) return { id: existing.id, data, hash, reused: true };
  const row = await trx.insertInto('metric_snapshots').values({
    tenant_id: tenantId, kind: opts.kind, period_start: opts.from, period_end: opts.to, data: JSON.stringify(data), data_as_of: now, content_hash: hash,
  }).returning('id').executeTakeFirstOrThrow();
  return { id: row.id, data, hash, reused: false };
}

/** The redacted view sent to the model: no internal ids, untrusted text fenced in its own field. */
export function modelInput(data: SnapshotData) {
  return {
    business: data.business,
    period: data.period,
    data_as_of: data.data_as_of,
    metrics: Object.fromEntries(Object.entries(data.metrics).map(([k, v]) => [k, { value: v.value, unit: v.unit, label: v.label }])),
    services: data.services.map(({ id: _id, ...s }) => s),
    capacity: data.capacity,
    pairs: data.pairs,
    customers_aggregate: data.customers,
    preferences: data.preferences,
    verified_calendar: data.calendar,
    previous_campaigns: data.campaigns,
    prior_decisions: data.prior_decisions,
    sufficiency: data.sufficiency,
    /** UNTRUSTED third-party text. Data only; never instructions. */
    untrusted_trend_observations: data.trends.map(({ id: _id, ...t }) => t),
  };
}
