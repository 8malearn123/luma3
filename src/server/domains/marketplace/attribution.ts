import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { withSystem, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { publicTenant } from '../storefront-public';
import { marketplaceSettings } from './listing';
import { ATTRIBUTION_WINDOW_HOURS, feeFor } from './rules';

/**
 * Marketplace attribution and the LUMA commission ledger.
 *
 * 1. /discover links to /s/{slug}?via=luma_market. The storefront records a
 *    marketplace visit for the pseudonymous analytics session (sessionStorage,
 *    the same session that links conversions, see analytics/events.ts).
 * 2. When that session places a storefront booking (header x-luma-session) at
 *    the same business within ATTRIBUTION_WINDOW_HOURS, the booking is tagged
 *    channel = 'marketplace' and the business's commission rate is snapshotted
 *    on it (marketplace_fee_bp). Direct storefront bookings stay 'direct' and
 *    never carry a commission.
 * 3. Online payments of a marketplace booking carry platform_fee_minor and
 *    provider_net_minor (DB trigger app.payment_platform_fee).
 * 4. When the booking completes, one commission line is written to
 *    marketplace_commissions (exactly once per booking).
 */

/** Listed right now (same rule as app.marketplace_directory()). */
async function isListed(trx: Tx, tenantId: string) {
  const s = await marketplaceSettings(trx);
  const r = await sql<{ ok: boolean }>`
    select (l.status = 'approved' and not l.hidden and t.status = 'active' and t.published_version_id is not null
            and (not ${s.require_verification} or coalesce(v.status = 'verified', false))) as ok
    from tenants t join marketplace_listings l on l.tenant_id = t.id left join tenant_verifications v on v.tenant_id = t.id
    where t.id = ${tenantId}`.execute(trx);
  return !!r.rows[0]?.ok;
}

async function effectiveRate(trx: Tx, tenantId: string) {
  const s = await marketplaceSettings(trx);
  const l = await trx.selectFrom('marketplace_listings').select('commission_bp').where('tenant_id', '=', tenantId).executeTakeFirst();
  return l?.commission_bp ?? s.default_commission_bp;
}

/** Records that this analytics session arrived from the marketplace. Silently ignored for unlisted businesses. */
export async function recordMarketplaceVisit(slug: string, sessionId: string | null) {
  if (!sessionId || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) throw Errors.invalid('session_required');
  const t = await publicTenant(slug);
  return withTenant(t.id, async (trx) => {
    if (!(await isListed(trx, t.id))) return { recorded: false };
    // Re-arriving from the marketplace refreshes the window.
    await trx.insertInto('marketplace_visits').values({ tenant_id: t.id, session_id: sessionId })
      .onConflict((oc) => oc.columns(['tenant_id', 'session_id']).doUpdateSet({ created_at: new Date() })).execute();
    return { recorded: true };
  });
}

/** Tags a just-created storefront booking as a marketplace booking when its session came from /discover. */
export async function attributeMarketplaceBooking(tenantId: string, bookingId: string, sessionId: string | null) {
  if (!sessionId) return { marketplace: false };
  return withTenant(tenantId, async (trx) => {
    const visit = await trx.selectFrom('marketplace_visits').select('created_at').where('tenant_id', '=', tenantId).where('session_id', '=', sessionId)
      .where('created_at', '>', new Date(Date.now() - ATTRIBUTION_WINDOW_HOURS * 3_600_000)).executeTakeFirst();
    if (!visit) return { marketplace: false };
    const b = await trx.selectFrom('bookings').select(['channel', 'source', 'attribution']).where('id', '=', bookingId).forUpdate().executeTakeFirst();
    if (!b || b.source !== 'storefront' || b.channel !== 'direct') return { marketplace: b?.channel === 'marketplace' };
    if (!(await isListed(trx, tenantId))) return { marketplace: false };
    const rate = await effectiveRate(trx, tenantId);
    const attribution = { ...((b.attribution as Record<string, unknown> | null) ?? {}), source: 'marketplace', marketplace_visit_at: visit.created_at.toISOString(), commission_bp: rate };
    await trx.updateTable('bookings').set({ channel: 'marketplace', marketplace_fee_bp: rate, attribution: JSON.stringify(attribution) }).where('id', '=', bookingId).execute();
    return { marketplace: true, commission_bp: rate };
  });
}

/**
 * Booking-completed hook (inside the completing transaction). One line per
 * marketplace booking: base = total − refunded at completion, fee at the rate
 * snapshotted on the booking. 'simulated' unless a split-capable (non-sandbox)
 * provider captured an online payment carrying the platform fee.
 */
export async function recordMarketplaceCommission(trx: Tx, tenantId: string, bookingId: string) {
  const b = await trx.selectFrom('bookings').select(['channel', 'marketplace_fee_bp', 'total_minor', 'refunded_minor', 'number', 'currency'])
    .where('id', '=', bookingId).executeTakeFirst();
  if (!b || b.channel !== 'marketplace' || b.marketplace_fee_bp == null) return { recorded: false };
  const base = Math.max(0, b.total_minor - b.refunded_minor);
  const split = await trx.selectFrom('payments').select('id').where('booking_id', '=', bookingId).where('status', '=', 'captured')
    .where('provider', '<>', 'sandbox').where('platform_fee_minor', '>', 0).executeTakeFirst();
  const row = await trx.insertInto('marketplace_commissions').values({
    tenant_id: tenantId, booking_id: bookingId, booking_number: b.number, base_minor: base, rate_bp: b.marketplace_fee_bp,
    fee_minor: feeFor(base, b.marketplace_fee_bp), currency: b.currency, settlement: split ? 'pending' : 'simulated',
  }).onConflict((oc) => oc.columns(['tenant_id', 'booking_id']).doNothing()).returning('id').executeTakeFirst();
  return { recorded: !!row };
}

export type FeePeriod = { from: string; to: string };

function periodBounds(period: FeePeriod, tz: string) {
  const from = DateTime.fromISO(period.from, { zone: tz }).startOf('day');
  const to = DateTime.fromISO(period.to, { zone: tz }).plus({ days: 1 }).startOf('day');
  if (!from.isValid || !to.isValid || to <= from) throw Errors.invalid('invalid_period', 'Invalid period');
  return { from: from.toJSDate(), to: to.toJSDate() };
}

export type MarketplaceFees = {
  tenant_id: string; currency: string; from: string; to: string;
  bookings: number; base_minor: number; fee_minor: number; simulated_fee_minor: number; pending_fee_minor: number;
  lines: Array<{ id: string; booking_id: string; booking_number: string; base_minor: number; rate_bp: number; fee_minor: number; settlement: string; created_at: Date }>;
};

/**
 * Public contract for payouts/finance (see docs/MARKETPLACE.md):
 * LUMA marketplace commission lines of one business whose booking completed
 * within [period.from, period.to] (inclusive calendar days, YYYY-MM-DD, in the
 * business's timezone), with totals in minor units. Read in the business's own
 * tenant scope (RLS), so it can be called from tenant or platform code.
 */
export async function marketplaceFeesFor(tenantId: string, period: FeePeriod): Promise<MarketplaceFees> {
  return withTenant(tenantId, async (trx) => {
    const t = await trx.selectFrom('tenants').select(['timezone', 'currency']).where('id', '=', tenantId).executeTakeFirst();
    if (!t) throw Errors.notFound('business');
    const b = periodBounds(period, t.timezone);
    const lines = await trx.selectFrom('marketplace_commissions').select(['id', 'booking_id', 'booking_number', 'base_minor', 'rate_bp', 'fee_minor', 'settlement', 'created_at'])
      .where('tenant_id', '=', tenantId).where('created_at', '>=', b.from).where('created_at', '<', b.to).orderBy('created_at').orderBy('id').execute();
    const sum = (f: (l: (typeof lines)[number]) => number) => lines.reduce((a, l) => a + f(l), 0);
    return {
      tenant_id: tenantId, currency: t.currency, from: period.from, to: period.to, bookings: lines.length,
      base_minor: sum((l) => l.base_minor), fee_minor: sum((l) => l.fee_minor),
      simulated_fee_minor: sum((l) => (l.settlement === 'simulated' ? l.fee_minor : 0)), pending_fee_minor: sum((l) => (l.settlement === 'pending' ? l.fee_minor : 0)),
      lines,
    };
  });
}

/** Platform ledger: totals per business for a period (UTC calendar days). */
export async function platformMarketplaceFees(period: FeePeriod) {
  const b = periodBounds(period, 'UTC');
  return withSystem('platform: marketplace commission ledger', async (trx) => {
    const rows = await trx.selectFrom('marketplace_commissions as c').innerJoin('tenants as t', 't.id', 'c.tenant_id')
      .select(['c.tenant_id', 't.slug', 't.name', 'c.currency',
        (eb) => eb.fn.countAll<number>().as('bookings'), (eb) => eb.fn.sum<number>('c.base_minor').as('base_minor'), (eb) => eb.fn.sum<number>('c.fee_minor').as('fee_minor')])
      .where('c.created_at', '>=', b.from).where('c.created_at', '<', b.to)
      .groupBy(['c.tenant_id', 't.slug', 't.name', 'c.currency']).orderBy('fee_minor', 'desc').execute();
    const items = rows.map((r) => ({ ...r, slug: String(r.slug), bookings: Number(r.bookings), base_minor: Number(r.base_minor), fee_minor: Number(r.fee_minor) }));
    return { from: period.from, to: period.to, items, total_fee_minor: items.reduce((a, r) => a + r.fee_minor, 0), total_bookings: items.reduce((a, r) => a + r.bookings, 0) };
  });
}
