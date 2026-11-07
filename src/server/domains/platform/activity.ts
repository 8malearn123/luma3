import { sql } from 'kysely';
import { withSystem } from '../../db/client';
import { PLATFORM_TZ } from './insights';
import { resolvePeriod } from '../analytics/period';

/**
 * Read-only, platform-wide bookings and payments (capability
 * platform.activity.view). Privacy: no customer identity, contact data or
 * notes (customer_note / internal_note / private notes are never selected);
 * rows carry the business, the readable number, statuses, source and money.
 */
type BookingQ = { tenant?: string; status?: string; source?: string; from?: string; to?: string; page: number; limit: number };
type PaymentQ = BookingQ & { method?: string };

function range(from?: string, to?: string) {
  if (!from && !to) return null;
  return resolvePeriod(PLATFORM_TZ, from, to ?? from, 31);
}

export async function platformBookings(q: BookingQ, opts: { all?: boolean } = {}) {
  return withSystem('platform: bookings across tenants (no customer data)', async (trx) => {
    let base = trx.selectFrom('bookings as b').innerJoin('tenants as t', 't.id', 'b.tenant_id');
    if (q.tenant) base = base.where(sql<string>`t.slug::text`, '=', q.tenant);
    if (q.status) base = base.where('b.status', '=', q.status);
    if (q.source) base = base.where('b.source', '=', q.source);
    const p = range(q.from, q.to);
    if (p) base = base.where('b.created_at', '>=', p.start).where('b.created_at', '<', p.end);
    const total = await base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    let rows = base.select(['b.id', 'b.number', 'b.status', 'b.payment_status', 'b.source', 'b.starts_at', 'b.ends_at', 'b.total_minor', 'b.paid_minor', 'b.refunded_minor', 'b.currency', 'b.created_at',
      't.id as tenant_id', sql<string>`t.slug::text`.as('tenant_slug'), 't.name as tenant_name', 't.city as tenant_city',
      sql<number>`(select count(*)::int from booking_items i where i.tenant_id = b.tenant_id and i.booking_id = b.id and i.superseded_at is null)`.as('items')])
      .orderBy('b.created_at', 'desc').orderBy('b.id', 'desc');
    rows = opts.all ? rows.limit(10_000) : rows.limit(q.limit).offset((q.page - 1) * q.limit);
    return { items: await rows.execute(), total: total.n, page: q.page, limit: q.limit };
  });
}

export async function platformPayments(q: PaymentQ, opts: { all?: boolean } = {}) {
  return withSystem('platform: payments across tenants (no customer data)', async (trx) => {
    let base = trx.selectFrom('payments as p').innerJoin('tenants as t', 't.id', 'p.tenant_id')
      .leftJoin('bookings as b', (j) => j.onRef('b.tenant_id', '=', 'p.tenant_id').onRef('b.id', '=', 'p.booking_id'))
      .leftJoin('orders as o', (j) => j.onRef('o.tenant_id', '=', 'p.tenant_id').onRef('o.id', '=', 'p.order_id'));
    if (q.tenant) base = base.where(sql<string>`t.slug::text`, '=', q.tenant);
    if (q.status) base = base.where('p.status', '=', q.status);
    if (q.source) base = base.where('p.purpose', '=', q.source);
    if (q.method) base = base.where('p.method', '=', q.method);
    const p = range(q.from, q.to);
    if (p) base = base.where('p.created_at', '>=', p.start).where('p.created_at', '<', p.end);
    const total = await base.select([sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(sum(p.amount_minor) filter (where p.status = 'captured'), 0)::bigint`.as('captured')]).executeTakeFirstOrThrow();
    let rows = base.select(['p.id', 'p.purpose', 'p.kind', 'p.method', 'p.amount_minor', 'p.currency', 'p.status', 'p.provider', 'p.needs_reconciliation', 'p.captured_at', 'p.created_at',
      't.id as tenant_id', sql<string>`t.slug::text`.as('tenant_slug'), 't.name as tenant_name',
      sql<string | null>`coalesce(b.number, o.number)`.as('reference'),
      sql<number>`(select coalesce(sum(r.amount_minor), 0)::bigint from refunds r where r.tenant_id = p.tenant_id and r.payment_id = p.id and r.status = 'succeeded')`.as('refunded_minor')])
      .orderBy('p.created_at', 'desc').orderBy('p.id', 'desc');
    rows = opts.all ? rows.limit(10_000) : rows.limit(q.limit).offset((q.page - 1) * q.limit);
    return { items: await rows.execute(), total: total.n, captured_minor: total.captured, page: q.page, limit: q.limit };
  });
}

// ── Live feed (bell + page) ─────────────────────────────────────────────────
export type FeedItem = {
  id: string; kind: 'booking' | 'payment' | 'order' | 'review' | 'signup'; at: Date;
  tenant_id: string; tenant_slug: string; tenant_name: string;
  amount_minor: number | null; currency: string | null; detail: string | null; link: string;
};

/**
 * New bookings, captured payments, orders, reviews and business sign-ups
 * across all tenants, newest first. Summary only (no customer identity or
 * review text); each item links to the tenant in /platform/tenants.
 */
export async function platformFeed(q: { since?: string; limit: number }) {
  const since = q.since ? new Date(q.since) : new Date(Date.now() - 7 * 86_400_000);
  return withSystem('platform: live activity feed (summaries)', async (trx) => {
    const r = await sql<Omit<FeedItem, 'link'>>`
      select * from (
        (select 'booking:' || b.id as id, 'booking' as kind, b.created_at as at, b.tenant_id, b.total_minor as amount_minor, b.currency::text as currency, b.source || ' · ' || b.number as detail
          from bookings b where b.created_at > ${since} and b.status not in ('draft', 'held', 'expired') order by b.created_at desc limit ${q.limit})
        union all
        (select 'payment:' || p.id, 'payment', p.captured_at, p.tenant_id, p.amount_minor, p.currency::text, p.purpose || ' · ' || p.method
          from payments p where p.status = 'captured' and p.captured_at > ${since} order by p.captured_at desc limit ${q.limit})
        union all
        (select 'order:' || o.id, 'order', o.created_at, o.tenant_id, o.total_minor, o.currency::text, o.number
          from orders o where o.created_at > ${since} and o.status <> 'draft' order by o.created_at desc limit ${q.limit})
        union all
        (select 'review:' || r.id, 'review', r.created_at, r.tenant_id, null::bigint, null, r.rating::text || '★'
          from reviews r where r.created_at > ${since} order by r.created_at desc limit ${q.limit})
        union all
        (select 'signup:' || t.id, 'signup', t.created_at, t.id, null::bigint, null, t.business_type || coalesce(' · ' || t.city, '')
          from tenants t where t.created_at > ${since} order by t.created_at desc limit ${q.limit})
      ) f order by at desc limit ${q.limit}`.execute(trx);
    const ids = [...new Set(r.rows.map((x) => x.tenant_id))];
    const tenants = ids.length ? await trx.selectFrom('tenants').select(['id', sql<string>`slug::text`.as('slug'), 'name']).where('id', 'in', ids).execute() : [];
    const byId = new Map(tenants.map((t) => [t.id, t]));
    const items: FeedItem[] = r.rows.map((x) => {
      const t = byId.get(x.tenant_id);
      return { ...x, tenant_slug: t?.slug ?? '', tenant_name: t?.name ?? '', link: `/platform/tenants?q=${encodeURIComponent(t?.slug ?? '')}` };
    });
    return { items, server_time: new Date().toISOString() };
  });
}
