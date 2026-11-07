import { sql } from 'kysely';
import type { Tx } from '../../db/client';

/**
 * INTEGRATION POINT — marketplace fees (LUMA's commission on bookings that
 * come from the LUMA marketplace; direct storefront bookings carry no fee).
 *
 * The marketplace branch (phase2-market) owns the fee model and exposes
 * `marketplaceFeesFor(tenantId, period)`. This branch does not contain it, so
 * settlements, analytics and reports read fees through this adapter:
 *
 *   1. Default source (works before and after the merge without code changes):
 *      if `bookings.marketplace_fee_minor` exists, sums it for the tenant's
 *      non-cancelled bookings created in the period; otherwise reports 0 with
 *      source 'unavailable'.
 *   2. After merging, wire the real function once at boot:
 *        setMarketplaceFeeSource({ name: 'market', forTenant: (trx, id, p) => marketplaceFeesFor(id, p) … })
 *      (see docs/PLATFORM_ADMIN.md › Integration points).
 */
export type FeePeriod = { from: string; to: string; start: Date; end: Date };
export type MarketplaceFees = { fee_minor: number; bookings: number; source: string };
export type MarketplaceFeeSource = {
  name: string;
  forTenant: (trx: Tx, tenantId: string, period: FeePeriod) => Promise<MarketplaceFees>;
  /** Optional bulk variant for platform-wide analytics; falls back to SQL/per-tenant calls. */
  byTenant?: (trx: Tx, period: FeePeriod) => Promise<Map<string, MarketplaceFees>>;
};

let columnKnown: boolean | null = null;
async function feeColumnExists(trx: Tx) {
  if (columnKnown !== null) return columnKnown;
  const r = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings' and column_name = 'marketplace_fee_minor'`.execute(trx);
  columnKnown = (r.rows[0]?.n ?? 0) > 0;
  return columnKnown;
}

const COUNTED = sql`status not in ('draft', 'held', 'expired', 'cancelled')`;

const defaultSource: MarketplaceFeeSource = {
  name: 'bookings.marketplace_fee_minor',
  async forTenant(trx, tenantId, p) {
    if (!(await feeColumnExists(trx))) return { fee_minor: 0, bookings: 0, source: 'unavailable' };
    const r = await sql<{ fee: number; n: number }>`
      select coalesce(sum(marketplace_fee_minor), 0)::bigint as fee, count(*) filter (where marketplace_fee_minor > 0)::int as n
      from bookings where tenant_id = ${tenantId} and created_at >= ${p.start} and created_at < ${p.end} and ${COUNTED}`.execute(trx);
    return { fee_minor: r.rows[0]?.fee ?? 0, bookings: r.rows[0]?.n ?? 0, source: 'bookings.marketplace_fee_minor' };
  },
  async byTenant(trx, p) {
    const out = new Map<string, MarketplaceFees>();
    if (!(await feeColumnExists(trx))) return out;
    const r = await sql<{ tenant_id: string; fee: number; n: number }>`
      select tenant_id, coalesce(sum(marketplace_fee_minor), 0)::bigint as fee, count(*) filter (where marketplace_fee_minor > 0)::int as n
      from bookings where created_at >= ${p.start} and created_at < ${p.end} and ${COUNTED} group by tenant_id`.execute(trx);
    for (const row of r.rows) out.set(row.tenant_id, { fee_minor: row.fee, bookings: row.n, source: 'bookings.marketplace_fee_minor' });
    return out;
  },
};

let current: MarketplaceFeeSource = defaultSource;

/** Replaces the fee source (after the marketplace merge, or in tests). Pass null to restore the default. */
export function setMarketplaceFeeSource(src: MarketplaceFeeSource | null) {
  current = src ?? defaultSource;
}

export function marketplaceFeeSourceName() {
  return current.name;
}

export async function marketplaceFeesForTenant(trx: Tx, tenantId: string, period: FeePeriod): Promise<MarketplaceFees> {
  return current.forTenant(trx, tenantId, period);
}

/** Fees for every tenant with activity in the period (system scope). */
export async function marketplaceFeesByTenant(trx: Tx, period: FeePeriod): Promise<Map<string, MarketplaceFees>> {
  if (current.byTenant) return current.byTenant(trx, period);
  const ids = await sql<{ tenant_id: string }>`select distinct tenant_id from bookings where created_at >= ${period.start} and created_at < ${period.end}`.execute(trx);
  const out = new Map<string, MarketplaceFees>();
  for (const { tenant_id } of ids.rows) {
    const f = await current.forTenant(trx, tenant_id, period);
    if (f.fee_minor) out.set(tenant_id, f);
  }
  return out;
}
