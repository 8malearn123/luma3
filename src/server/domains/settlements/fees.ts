import { sql } from 'kysely';
import type { Tx } from '../../db/client';

/**
 * Marketplace fees: LUMA's commission on bookings that come from سوق لوما
 * (direct storefront bookings carry no fee). Settlements, platform analytics
 * and reports read fees through this adapter; the default source is the
 * marketplace commission ledger. Tests may swap it with setMarketplaceFeeSource().
 */
export type FeePeriod = { from: string; to: string; start: Date; end: Date };
export type MarketplaceFees = { fee_minor: number; bookings: number; source: string };
export type MarketplaceFeeSource = {
  name: string;
  forTenant: (trx: Tx, tenantId: string, period: FeePeriod) => Promise<MarketplaceFees>;
  /** Optional bulk variant for platform-wide analytics; falls back to SQL/per-tenant calls. */
  byTenant?: (trx: Tx, period: FeePeriod) => Promise<Map<string, MarketplaceFees>>;
};

/**
 * LUMA's marketplace fee is the append-only `marketplace_commissions` ledger
 * (one line per completed marketplace booking, domains/marketplace). A line
 * belongs to the period in which it was created (the booking's completion).
 */
const defaultSource: MarketplaceFeeSource = {
  name: 'marketplace_commissions',
  async forTenant(trx, tenantId, p) {
    const r = await sql<{ fee: number; n: number }>`
      select coalesce(sum(fee_minor), 0)::bigint as fee, count(*)::int as n
      from marketplace_commissions where tenant_id = ${tenantId} and created_at >= ${p.start} and created_at < ${p.end}`.execute(trx);
    return { fee_minor: r.rows[0]?.fee ?? 0, bookings: r.rows[0]?.n ?? 0, source: 'marketplace_commissions' };
  },
  async byTenant(trx, p) {
    const out = new Map<string, MarketplaceFees>();
    const r = await sql<{ tenant_id: string; fee: number; n: number }>`
      select tenant_id, coalesce(sum(fee_minor), 0)::bigint as fee, count(*)::int as n
      from marketplace_commissions where created_at >= ${p.start} and created_at < ${p.end} group by tenant_id`.execute(trx);
    for (const row of r.rows) out.set(row.tenant_id, { fee_minor: row.fee, bookings: row.n, source: 'marketplace_commissions' });
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
