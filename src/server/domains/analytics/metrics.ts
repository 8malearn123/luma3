import { sql, withTenant, type Tx } from '../../db/client';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { SERVER_SESSION_PREFIX } from './events';
import { addDays, resolvePeriod, type Period } from './period';

/**
 * Storefront metrics, computed programmatically from observed events only.
 *
 *  eligible session  = a session_id with at least one non-excluded client event
 *                      in the period (server-only pseudo sessions never count).
 *  conversion rate   = eligible sessions with ≥1 conversion (booking_confirmed
 *                      or order_paid linked to that session) ÷ eligible sessions.
 *  bookings/session  = booking_confirmed events linked to eligible sessions ÷
 *                      eligible sessions (can exceed 1: one session, many bookings).
 * Missing referrer/device values are reported as "unknown", never guessed.
 */

const SRV = `${SERVER_SESSION_PREFIX}%`;
const ACTIVE_BOOKING = ['confirmed', 'checked_in', 'in_service', 'completed'] as const;
const PAID_ORDER = ['paid', 'preparing', 'ready', 'collected'] as const;

export type FunnelTotals = {
  sessions: number; page_views: number; service_views: number; product_views: number; booking_starts: number; checkout_starts: number;
  bookings_confirmed: number; orders_paid: number; conversion_sessions: number; session_bookings: number; availability_empty: number; waitlist_joins: number;
  excluded_events: number;
};

export async function funnelTotals(trx: Tx, tenantId: string, start: Date, end: Date): Promise<FunnelTotals> {
  const r = await sql<FunnelTotals>`
    with ev as (
      select session_id, type, is_excluded from analytics_events
      where tenant_id = ${tenantId} and occurred_at >= ${start} and occurred_at < ${end}
    ),
    eligible as (
      select distinct session_id from ev where not is_excluded and session_id not like ${SRV}
        and type not in ('booking_confirmed', 'order_paid')
    ),
    conv as (
      select session_id, count(*) filter (where type = 'booking_confirmed') as bookings
      from ev where not is_excluded and type in ('booking_confirmed', 'order_paid') group by session_id
    )
    select
      (select count(*) from eligible)::int as sessions,
      (select count(*) from ev where not is_excluded and type = 'page_view')::int as page_views,
      (select count(*) from ev where not is_excluded and type = 'service_view')::int as service_views,
      (select count(*) from ev where not is_excluded and type = 'product_view')::int as product_views,
      (select count(*) from ev where not is_excluded and type = 'booking_start')::int as booking_starts,
      (select count(*) from ev where not is_excluded and type = 'checkout_start')::int as checkout_starts,
      (select count(*) from ev where not is_excluded and type = 'booking_confirmed')::int as bookings_confirmed,
      (select count(*) from ev where not is_excluded and type = 'order_paid')::int as orders_paid,
      (select count(*) from conv join eligible using (session_id))::int as conversion_sessions,
      (select coalesce(sum(bookings), 0) from conv join eligible using (session_id))::int as session_bookings,
      (select count(*) from ev where not is_excluded and type = 'availability_empty')::int as availability_empty,
      (select count(*) from ev where not is_excluded and type = 'waitlist_join')::int as waitlist_joins,
      (select count(*) from ev where is_excluded)::int as excluded_events`.execute(trx);
  return r.rows[0]!;
}

export function rates(t: FunnelTotals) {
  return {
    conversion_rate: t.sessions > 0 ? t.conversion_sessions / t.sessions : null,
    bookings_per_session: t.sessions > 0 ? t.session_bookings / t.sessions : null,
  };
}

async function breakdowns(trx: Tx, tenantId: string, start: Date, end: Date) {
  const firstTouch = await sql<{ source: string; device: string; n: number }>`
    with first as (
      select distinct on (session_id) session_id, referrer_host, utm->>'source' as utm_source, device
      from analytics_events
      where tenant_id = ${tenantId} and occurred_at >= ${start} and occurred_at < ${end}
        and not is_excluded and session_id not like ${SRV} and type not in ('booking_confirmed', 'order_paid')
      order by session_id, occurred_at
    )
    select coalesce(nullif(utm_source, ''), referrer_host, 'direct_or_unknown') as source, coalesce(device, 'unknown') as device, count(*)::int as n
    from first group by 1, 2`.execute(trx);
  const sources = new Map<string, number>();
  const devices = new Map<string, number>();
  for (const r of firstTouch.rows) {
    sources.set(r.source, (sources.get(r.source) ?? 0) + r.n);
    devices.set(r.device, (devices.get(r.device) ?? 0) + r.n);
  }
  const sort = (m: Map<string, number>) => [...m].map(([key, sessions]) => ({ key, sessions })).sort((a, b) => b.sessions - a.sessions);
  const excluded = await sql<{ reason: string; n: number }>`
    select exclusion_reason as reason, count(*)::int as n from analytics_events
    where tenant_id = ${tenantId} and occurred_at >= ${start} and occurred_at < ${end} and is_excluded group by 1 order by 2 desc`.execute(trx);
  return { sources: sort(sources).slice(0, 10), devices: sort(devices), excluded: excluded.rows };
}

export async function topServices(trx: Tx, tenantId: string, start: Date, end: Date, limit = 10) {
  const r = await sql<{ service_id: string; name_ar: string | null; name_en: string | null; views: number; booking_starts: number; confirmed: number; completed: number }>`
    with v as (
      select entity_id, count(*) filter (where type = 'service_view')::int as views, count(*) filter (where type = 'booking_start')::int as booking_starts
      from analytics_events where tenant_id = ${tenantId} and occurred_at >= ${start} and occurred_at < ${end} and not is_excluded and entity_id is not null
        and type in ('service_view', 'booking_start') group by entity_id
    ),
    b as (
      select bi.service_id, count(*) filter (where bk.status in ('confirmed', 'checked_in', 'in_service'))::int as confirmed,
             count(*) filter (where bk.status = 'completed')::int as completed
      from booking_items bi join bookings bk on bk.id = bi.booking_id and bk.tenant_id = bi.tenant_id
      where bi.tenant_id = ${tenantId} and bi.starts_at >= ${start} and bi.starts_at < ${end} and bk.status in ('confirmed', 'checked_in', 'in_service', 'completed')
      group by bi.service_id
    )
    select s.id as service_id, s.name_ar, s.name_en, coalesce(v.views, 0) as views, coalesce(v.booking_starts, 0) as booking_starts,
           coalesce(b.confirmed, 0) as confirmed, coalesce(b.completed, 0) as completed
    from services s left join v on v.entity_id = s.id left join b on b.service_id = s.id
    where s.tenant_id = ${tenantId} and (v.entity_id is not null or b.service_id is not null)
    order by coalesce(b.completed, 0) + coalesce(b.confirmed, 0) desc, coalesce(v.views, 0) desc limit ${limit}`.execute(trx);
  return r.rows;
}

export async function topProducts(trx: Tx, tenantId: string, start: Date, end: Date, limit = 10) {
  const r = await sql<{ product_id: string; name_ar: string | null; name_en: string | null; views: number; units_paid: number }>`
    with v as (
      select entity_id, count(*)::int as views from analytics_events
      where tenant_id = ${tenantId} and occurred_at >= ${start} and occurred_at < ${end} and not is_excluded and type = 'product_view' and entity_id is not null
      group by entity_id
    ),
    o as (
      select oi.product_id, sum(oi.quantity)::int as units from order_items oi join orders o on o.id = oi.order_id and o.tenant_id = oi.tenant_id
      where oi.tenant_id = ${tenantId} and o.created_at >= ${start} and o.created_at < ${end} and o.status in ('paid', 'preparing', 'ready', 'collected')
      group by oi.product_id
    )
    select p.id as product_id, p.name_ar, p.name_en, coalesce(v.views, 0) as views, coalesce(o.units, 0) as units_paid
    from products p left join v on v.entity_id = p.id left join o on o.product_id = p.id
    where p.tenant_id = ${tenantId} and (v.entity_id is not null or o.product_id is not null)
    order by coalesce(o.units, 0) desc, coalesce(v.views, 0) desc limit ${limit}`.execute(trx);
  return r.rows;
}

/** Storefront dashboard summary for a period (tenant-local days). */
export async function storefrontSummary(access: TenantAccess, q: { from?: string; to?: string }) {
  const period = resolvePeriod(access.timezone, q.from, q.to, 30);
  const showMoney = hasCapability(access, ['bookings.view_financial', 'finance.view']);
  return withTenant(access.tenantId, async (trx) => {
    const totals = await funnelTotals(trx, access.tenantId, period.start, period.end);
    const prevPeriod = resolvePeriod(access.timezone, addDays(period.from, -period.days), addDays(period.from, -1));
    const previous = await funnelTotals(trx, access.tenantId, prevPeriod.start, prevPeriod.end);
    const br = await breakdowns(trx, access.tenantId, period.start, period.end);
    const services = await topServices(trx, access.tenantId, period.start, period.end, 8);
    const products = await topProducts(trx, access.tenantId, period.start, period.end, 8);
    const recentBookings = await trx.selectFrom('bookings').select(['id', 'number', 'status', 'source', 'starts_at', 'created_at', 'total_minor', 'currency'])
      .where('tenant_id', '=', access.tenantId).where('status', 'not in', ['draft', 'held']).orderBy('created_at', 'desc').limit(5).execute();
    const recentOrders = await trx.selectFrom('orders').select(['id', 'number', 'status', 'created_at', 'total_minor', 'currency'])
      .where('tenant_id', '=', access.tenantId).where('status', 'in', [...PAID_ORDER, 'pending_payment', 'cancelled']).orderBy('created_at', 'desc').limit(5).execute();
    const series = await trx.selectFrom('daily_metrics').select(['day', 'metric', 'value', 'computed_at'])
      .where('tenant_id', '=', access.tenantId).where('dimension', '=', '').where('day', '>=', period.from).where('day', '<=', period.to)
      .where('metric', 'in', ['sessions', 'conversion_sessions', 'bookings_confirmed', 'orders_paid']).orderBy('day').execute();
    const strip = <T extends { total_minor: number }>(r: T) => (showMoney ? r : { ...r, total_minor: null });
    return {
      period: { from: period.from, to: period.to, timezone: period.timezone, days: period.days },
      totals, rates: rates(totals),
      previous: { from: prevPeriod.from, to: prevPeriod.to, totals: previous, rates: rates(previous) },
      sources: br.sources, devices: br.devices, excluded: br.excluded,
      top_services: services, top_products: products,
      recent_bookings: recentBookings.map(strip), recent_orders: recentOrders.map(strip),
      series: series.map((s) => ({ day: s.day, metric: s.metric, value: Number(s.value) })),
      series_computed_at: series.reduce<Date | null>((m, s) => (!m || s.computed_at > m ? s.computed_at : m), null),
      definitions: {
        session: 'pseudonymous_session_id',
        conversion_rate: 'eligible_sessions_with_conversion_div_eligible_sessions',
        bookings_per_session: 'session_linked_bookings_div_eligible_sessions',
      },
    };
  });
}

/**
 * Service demand as SEPARATE signals: views, booking starts, confirmed and
 * completed bookings, waitlist joins, and "no availability" moments. A view is
 * never treated as a booking.
 */
export async function serviceDemand(trx: Tx, tenantId: string, start: Date, end: Date) {
  const r = await sql<{
    service_id: string; name_ar: string | null; name_en: string | null; price_minor: number; cost_minor: number | null; duration_min: number;
    views: number; booking_starts: number; availability_empty: number; waitlist_events: number; waitlist_entries: number; confirmed: number; completed: number;
    cancelled: number; no_show: number;
  }>`
    with v as (
      select entity_id,
        count(*) filter (where type = 'service_view')::int as views,
        count(*) filter (where type = 'booking_start')::int as booking_starts,
        count(*) filter (where type = 'availability_empty')::int as availability_empty,
        count(*) filter (where type = 'waitlist_join')::int as waitlist_events
      from analytics_events where tenant_id = ${tenantId} and occurred_at >= ${start} and occurred_at < ${end} and not is_excluded and entity_id is not null
      group by entity_id
    ),
    b as (
      select bi.service_id,
        count(*) filter (where bk.status in ('confirmed', 'checked_in', 'in_service'))::int as confirmed,
        count(*) filter (where bk.status = 'completed')::int as completed,
        count(*) filter (where bk.status = 'cancelled')::int as cancelled,
        count(*) filter (where bk.status = 'no_show')::int as no_show
      from booking_items bi join bookings bk on bk.id = bi.booking_id and bk.tenant_id = bi.tenant_id
      where bi.tenant_id = ${tenantId} and bi.starts_at >= ${start} and bi.starts_at < ${end}
      group by bi.service_id
    ),
    w as (
      select service_id, count(*)::int as n from waitlist_entries where tenant_id = ${tenantId} and created_at >= ${start} and created_at < ${end} group by service_id
    )
    select s.id as service_id, s.name_ar, s.name_en, s.price_minor, s.cost_minor, s.duration_min,
      coalesce(v.views, 0) as views, coalesce(v.booking_starts, 0) as booking_starts, coalesce(v.availability_empty, 0) as availability_empty,
      coalesce(v.waitlist_events, 0) as waitlist_events, coalesce(w.n, 0) as waitlist_entries,
      coalesce(b.confirmed, 0) as confirmed, coalesce(b.completed, 0) as completed, coalesce(b.cancelled, 0) as cancelled, coalesce(b.no_show, 0) as no_show
    from services s left join v on v.entity_id = s.id left join b on b.service_id = s.id left join w on w.service_id = s.id
    where s.tenant_id = ${tenantId} and s.archived_at is null
    order by s.sort, s.created_at`.execute(trx);
  return r.rows;
}

export async function demandReport(access: TenantAccess, q: { from?: string; to?: string }) {
  const period = resolvePeriod(access.timezone, q.from, q.to, 30);
  const showCost = hasCapability(access, 'costs.view');
  return withTenant(access.tenantId, async (trx) => {
    const rows = await serviceDemand(trx, access.tenantId, period.start, period.end);
    return {
      period: { from: period.from, to: period.to, timezone: period.timezone },
      services: rows.map(({ cost_minor, ...r }) => ({ ...r, ...(showCost ? { cost_minor } : {}) })),
      note: 'signals_are_separate',
    };
  });
}

// ── Daily rollup ─────────────────────────────────────────────────────────────
/**
 * Upserts daily_metrics for one tenant-local day. Idempotent: re-running for
 * the same day overwrites the same keys with freshly computed values.
 */
export async function rollupDay(trx: Tx, tenantId: string, timezone: string, day: string) {
  const p: Period = resolvePeriod(timezone, day, day);
  const t = await funnelTotals(trx, tenantId, p.start, p.end);
  const br = await breakdowns(trx, tenantId, p.start, p.end);
  const rows: Array<{ metric: string; dimension: string; value: number }> = [
    ...Object.entries(t).map(([metric, value]) => ({ metric, dimension: '', value })),
    ...br.devices.map((d) => ({ metric: 'sessions', dimension: `device:${d.key}`, value: d.sessions })),
    ...br.sources.map((s) => ({ metric: 'sessions', dimension: `source:${s.key}`.slice(0, 200), value: s.sessions })),
  ];
  for (const r of rows) {
    await sql`insert into daily_metrics (tenant_id, day, metric, dimension, value, computed_at)
      values (${tenantId}, ${day}, ${r.metric}, ${r.dimension}, ${r.value}, now())
      on conflict (tenant_id, day, metric, dimension) do update set value = excluded.value, computed_at = excluded.computed_at`.execute(trx);
  }
  return { day, metrics: rows.length };
}

export const _internal = { ACTIVE_BOOKING };
