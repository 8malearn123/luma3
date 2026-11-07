import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { withSystem, type Tx } from '../../db/client';
import { addDays, resolvePeriod, type Period } from '../analytics/period';
import { marketplaceFeesByTenant } from '../settlements/fees';
import { vatOfInclusive, VAT_RATE_BP } from '@/shared/platform-settings';
import type { ReportKind } from '@/shared/schemas/admin';

/**
 * Platform-wide analytics and reports (LUMA staff only, aggregates across
 * tenants, no customer identity). All periods are Asia/Riyadh calendar days.
 * Revenue = LUMA subscription invoices paid + marketplace fees (via the fee
 * adapter in settlements/fees.ts). Amounts are VAT-inclusive.
 */
export const PLATFORM_TZ = 'Asia/Riyadh';
const LIVE = sql`b.status not in ('draft', 'held', 'expired')`;

export function platformPeriod(from?: string, to?: string) {
  return resolvePeriod(PLATFORM_TZ, from, to, 30);
}

async function feesTotal(trx: Tx, p: Period) {
  const m = await marketplaceFeesByTenant(trx, p);
  let fee = 0;
  for (const v of m.values()) fee += v.fee_minor;
  return { fee_minor: fee, by_tenant: m };
}

async function subscriptionRevenue(trx: Tx, p: Period) {
  const r = await sql<{ paid: number; n: number }>`select coalesce(sum(amount_minor), 0)::bigint as paid, count(*)::int as n from platform_invoices
    where status = 'paid' and paid_at >= ${p.start} and paid_at < ${p.end}`.execute(trx);
  return { paid_minor: r.rows[0]?.paid ?? 0, invoices: r.rows[0]?.n ?? 0 };
}

export async function platformAnalytics(q: { from?: string; to?: string }) {
  const p = platformPeriod(q.from, q.to);
  const prevEnd = addDays(p.from, -1);
  const prev = resolvePeriod(PLATFORM_TZ, addDays(prevEnd, -(p.days - 1)), prevEnd);
  return withSystem('platform: analytics aggregates', async (trx) => {
    const totals = await sql<{ bookings: number; completed: number; cancelled: number; gmv: number; new_businesses: number }>`
      select (select count(*)::int from bookings b where b.created_at >= ${p.start} and b.created_at < ${p.end} and ${LIVE}) as bookings,
        (select count(*)::int from bookings b where b.created_at >= ${p.start} and b.created_at < ${p.end} and b.status = 'completed') as completed,
        (select count(*)::int from bookings b where b.created_at >= ${p.start} and b.created_at < ${p.end} and b.status in ('cancelled', 'no_show')) as cancelled,
        (select coalesce(sum(b.total_minor), 0)::bigint from bookings b where b.created_at >= ${p.start} and b.created_at < ${p.end} and b.status = 'completed') as gmv,
        (select count(*)::int from tenants where created_at >= ${p.start} and created_at < ${p.end}) as new_businesses`.execute(trx);
    const byCategory = await sql<{ category: string; category_en: string | null; bookings: number; revenue_minor: number }>`
      select coalesce(c.name_ar, c.name_en, 'غير مصنّف') as category, coalesce(c.name_en, c.name_ar) as category_en,
        count(distinct b.id)::int as bookings, coalesce(sum(i.line_total_minor), 0)::bigint as revenue_minor
      from bookings b
      join booking_items i on i.tenant_id = b.tenant_id and i.booking_id = b.id and i.superseded_at is null
      left join services s on s.tenant_id = i.tenant_id and s.id = i.service_id
      left join categories c on c.tenant_id = s.tenant_id and c.id = s.category_id
      where b.created_at >= ${p.start} and b.created_at < ${p.end} and ${LIVE}
      group by 1, 2 order by bookings desc limit 50`.execute(trx);
    const byCity = await sql<{ city: string; bookings: number; businesses: number }>`
      select coalesce(nullif(trim(t.city), ''), '—') as city, count(b.id)::int as bookings, count(distinct t.id)::int as businesses
      from bookings b join tenants t on t.id = b.tenant_id
      where b.created_at >= ${p.start} and b.created_at < ${p.end} and ${LIVE}
      group by 1 order by bookings desc limit 50`.execute(trx);
    const conversion = await sql<{ trials: number; converted: number }>`
      select count(*)::int as trials,
        count(*) filter (where s.status = 'active' or exists (select 1 from subscription_events e where e.subscription_id = s.id and e.to_status = 'active'))::int as converted
      from subscriptions s where s.created_at >= ${p.start} and s.created_at < ${p.end}`.execute(trx);
    const retention = await sql<{ base: number; retained: number }>`
      with prev as (select distinct tenant_id from bookings b where b.created_at >= ${prev.start} and b.created_at < ${prev.end} and ${LIVE}),
           cur as (select distinct tenant_id from bookings b where b.created_at >= ${p.start} and b.created_at < ${p.end} and ${LIVE})
      select (select count(*)::int from prev) as base, (select count(*)::int from prev join cur using (tenant_id)) as retained`.execute(trx);
    const subsRetention = await sql<{ active_start: number; still_current: number }>`
      select count(*)::int as active_start,
        count(*) filter (where s.status in ('trialing', 'active', 'past_due', 'paused'))::int as still_current
      from subscriptions s where s.created_at < ${p.start} and (s.cancelled_at is null or s.cancelled_at >= ${p.start})`.execute(trx);
    const rating = await sql<{ avg: number | null; n: number }>`
      select round(avg(rating)::numeric, 2)::float8 as avg, count(*)::int as n from reviews
      where status = 'published' and created_at >= ${p.start} and created_at < ${p.end}`.execute(trx);
    const peak = await sql<{ dow: number; hour: number; bookings: number }>`
      select extract(dow from b.starts_at at time zone ${PLATFORM_TZ})::int as dow, extract(hour from b.starts_at at time zone ${PLATFORM_TZ})::int as hour, count(*)::int as bookings
      from bookings b where b.starts_at >= ${p.start} and b.starts_at < ${p.end} and ${LIVE}
      group by 1, 2 order by 1, 2`.execute(trx);
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, bookings: peak.rows.filter((r) => r.hour === h).reduce((a, r) => a + r.bookings, 0) }));
    const subs = await subscriptionRevenue(trx, p);
    const fees = await feesTotal(trx, p);
    const t = totals.rows[0]!;
    const conv = conversion.rows[0]!;
    const ret = retention.rows[0]!;
    const sr = subsRetention.rows[0]!;
    return {
      period: { from: p.from, to: p.to, days: p.days, timezone: PLATFORM_TZ, previous: { from: prev.from, to: prev.to } },
      totals: { ...t, gmv_minor: t.gmv },
      bookings_by_category: byCategory.rows,
      bookings_by_city: byCity.rows,
      trial_conversion: { trials: conv.trials, converted: conv.converted, rate: conv.trials ? conv.converted / conv.trials : null },
      provider_retention: {
        booking_active_previous: ret.base, booking_active_both: ret.retained, rate: ret.base ? ret.retained / ret.base : null,
        subscriptions_at_start: sr.active_start, subscriptions_still_current: sr.still_current, subscription_rate: sr.active_start ? sr.still_current / sr.active_start : null,
      },
      average_rating: { average: rating.rows[0]?.avg ?? null, reviews: rating.rows[0]?.n ?? 0 },
      peak_hours: { by_hour: hours, heatmap: peak.rows, top: [...hours].sort((a, b) => b.bookings - a.bookings).slice(0, 3).filter((h) => h.bookings > 0) },
      revenue: { subscriptions_minor: subs.paid_minor, subscription_invoices: subs.invoices, marketplace_fees_minor: fees.fee_minor, total_minor: subs.paid_minor + fees.fee_minor, currency: 'SAR', vat_inclusive: true },
    };
  });
}

/** Flattens analytics into rows for CSV. */
export function analyticsCsvRows(a: Awaited<ReturnType<typeof platformAnalytics>>) {
  const rows: Array<{ section: string; key: string; value: string | number | null; extra: string | number | null }> = [];
  const add = (section: string, key: string, value: string | number | null, extra: string | number | null = null) => rows.push({ section, key, value, extra });
  add('period', 'from', a.period.from); add('period', 'to', a.period.to);
  for (const [k, v] of Object.entries(a.totals)) add('totals', k, v as number);
  for (const c of a.bookings_by_category) add('bookings_by_category', c.category, c.bookings, c.revenue_minor / 100);
  for (const c of a.bookings_by_city) add('bookings_by_city', c.city, c.bookings, c.businesses);
  add('trial_conversion', 'trials', a.trial_conversion.trials); add('trial_conversion', 'converted', a.trial_conversion.converted); add('trial_conversion', 'rate', a.trial_conversion.rate);
  for (const [k, v] of Object.entries(a.provider_retention)) add('provider_retention', k, v as number | null);
  add('average_rating', 'average', a.average_rating.average); add('average_rating', 'reviews', a.average_rating.reviews);
  for (const h of a.peak_hours.by_hour) add('peak_hours', String(h.hour).padStart(2, '0'), h.bookings);
  add('revenue', 'subscriptions_sar', a.revenue.subscriptions_minor / 100); add('revenue', 'marketplace_fees_sar', a.revenue.marketplace_fees_minor / 100); add('revenue', 'total_sar', a.revenue.total_minor / 100);
  return rows;
}

// ── Reports ─────────────────────────────────────────────────────────────────
function monthsIn(p: Period) {
  const out: Array<{ month: string; period: Period }> = [];
  let cur = DateTime.fromISO(p.from).startOf('month');
  const last = DateTime.fromISO(p.to);
  while (cur <= last) {
    const from = cur.toISODate()! < p.from ? p.from : cur.toISODate()!;
    const endOfMonth = cur.endOf('month').toISODate()!;
    const to = endOfMonth > p.to ? p.to : endOfMonth;
    out.push({ month: cur.toFormat('yyyy-MM'), period: resolvePeriod(PLATFORM_TZ, from, to) });
    cur = cur.plus({ months: 1 });
  }
  return out;
}

export async function platformReport(kind: ReportKind, q: { from?: string; to?: string }) {
  const p = platformPeriod(q.from, q.to);
  return withSystem(`platform: report ${kind}`, async (trx) => {
    switch (kind) {
      case 'monthly_revenue': {
        const rows = [];
        for (const { month, period } of monthsIn(p)) {
          const subs = await subscriptionRevenue(trx, period);
          const fees = await feesTotal(trx, period);
          const total = subs.paid_minor + fees.fee_minor;
          rows.push({ month, subscriptions_minor: subs.paid_minor, subscription_invoices: subs.invoices, marketplace_fees_minor: fees.fee_minor, total_minor: total, vat_minor: vatOfInclusive(total), net_of_vat_minor: total - vatOfInclusive(total) });
        }
        return { kind, period: { from: p.from, to: p.to }, rows };
      }
      case 'vat_summary': {
        const subs = await subscriptionRevenue(trx, p);
        const fees = await feesTotal(trx, p);
        const line = (source: string, gross: number) => ({ source, gross_minor: gross, vat_minor: vatOfInclusive(gross), net_minor: gross - vatOfInclusive(gross), vat_rate_bp: VAT_RATE_BP });
        const rows = [line('subscriptions', subs.paid_minor), line('marketplace_fees', fees.fee_minor)];
        rows.push(line('total', subs.paid_minor + fees.fee_minor));
        return { kind, period: { from: p.from, to: p.to }, rows, note: 'Output VAT on LUMA revenue (VAT-inclusive prices, 15%). Subscription invoices are test-mode until real billing exists.' };
      }
      case 'provider_performance': {
        const r = await sql<{ tenant_id: string; slug: string; name: string; city: string | null; bookings: number; completed: number; cancelled: number; no_show: number; gmv_minor: number; reviews: number; avg_rating: number | null }>`
          select t.id as tenant_id, t.slug::text as slug, t.name, t.city,
            count(b.id) filter (where ${LIVE})::int as bookings,
            count(b.id) filter (where b.status = 'completed')::int as completed,
            count(b.id) filter (where b.status = 'cancelled')::int as cancelled,
            count(b.id) filter (where b.status = 'no_show')::int as no_show,
            coalesce(sum(b.total_minor) filter (where b.status = 'completed'), 0)::bigint as gmv_minor,
            (select count(*)::int from reviews r where r.tenant_id = t.id and r.status = 'published' and r.created_at >= ${p.start} and r.created_at < ${p.end}) as reviews,
            (select round(avg(r.rating)::numeric, 2)::float8 from reviews r where r.tenant_id = t.id and r.status = 'published' and r.created_at >= ${p.start} and r.created_at < ${p.end}) as avg_rating
          from tenants t left join bookings b on b.tenant_id = t.id and b.created_at >= ${p.start} and b.created_at < ${p.end}
          group by t.id order by bookings desc, t.name limit 1000`.execute(trx);
        const fees = await feesTotal(trx, p);
        const rows = r.rows.map((x) => ({ ...x, cancellation_rate: x.bookings ? Number(((x.cancelled + x.no_show) / x.bookings).toFixed(4)) : null, marketplace_fees_minor: fees.by_tenant.get(x.tenant_id)?.fee_minor ?? 0 }));
        return { kind, period: { from: p.from, to: p.to }, rows };
      }
      case 'bookings': {
        const r = await sql<{ month: string; status: string; source: string; bookings: number; total_minor: number }>`
          select to_char(b.created_at at time zone ${PLATFORM_TZ}, 'YYYY-MM') as month, b.status, b.source, count(*)::int as bookings, coalesce(sum(b.total_minor), 0)::bigint as total_minor
          from bookings b where b.created_at >= ${p.start} and b.created_at < ${p.end}
          group by 1, 2, 3 order by 1, 2, 3`.execute(trx);
        return { kind, period: { from: p.from, to: p.to }, rows: r.rows };
      }
    }
  });
}

/** CSV rows: money columns in SAR (major units) next to the halala values. */
export function reportCsvRows(rows: Array<Record<string, unknown>>) {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'tenant_id') continue;
      if (k.endsWith('_minor') && typeof v === 'number') out[k.replace(/_minor$/, '_sar')] = (v / 100).toFixed(2);
      else out[k] = v;
    }
    return out;
  });
}
