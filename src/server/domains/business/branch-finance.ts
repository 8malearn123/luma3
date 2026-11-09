import { DateTime } from 'luxon';
import { sql, withTenant } from '../../db/client';
import type { TenantAccess } from '../../tenancy/access';

/**
 * Branch slice of the finance report for the branch switcher. The journal is
 * kept per business (one ledger), so ledger figures (recognised revenue,
 * deposits, receivables, profit) stay business-wide; what carries a branch —
 * bookings, product orders, their captured payments and branch expenses — is
 * reported here per selected branch.
 */
export async function branchFinance(access: TenantAccess, fromISO: string, toISO: string, branchIds: string[]) {
  const tz = access.timezone;
  const from = DateTime.fromISO(fromISO, { zone: tz }).startOf('day').toJSDate();
  const to = DateTime.fromISO(toISO, { zone: tz }).endOf('day').toJSDate();
  return withTenant(access.tenantId, async (trx) => {
    if (!branchIds.length) return { branch_ids: [], booking_value_minor: 0, bookings: 0, collections_minor: 0, expenses_minor: 0, discounts_minor: 0, ledger_scope: 'business' as const };
    const bv = await trx.selectFrom('bookings').select([sql<number>`coalesce(sum(total_minor),0)::bigint`.as('v'), sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(sum(discount_minor) filter (where status = 'completed'),0)::bigint`.as('d')])
      .where('status', 'in', ['confirmed', 'checked_in', 'in_service', 'completed']).where('starts_at', '>=', from).where('starts_at', '<=', to)
      .where('branch_id', 'in', branchIds).executeTakeFirstOrThrow();
    const col = await sql<{ v: number }>`
      select coalesce(sum(p.amount_minor), 0)::bigint as v from payments p
      left join bookings b on b.id = p.booking_id left join orders o on o.id = p.order_id
      where p.status = 'captured' and p.captured_at >= ${from} and p.captured_at <= ${to}
        and coalesce(b.branch_id, o.branch_id) = any(${branchIds}::uuid[])`.execute(trx);
    const ex = await trx.selectFrom('expenses').select(sql<number>`coalesce(sum(amount_minor),0)::bigint`.as('v')).where('voided_at', 'is', null)
      .where('incurred_on', '>=', fromISO).where('incurred_on', '<=', toISO).where('branch_id', 'in', branchIds).executeTakeFirstOrThrow();
    return {
      branch_ids: branchIds, booking_value_minor: Number(bv.v), bookings: bv.n, collections_minor: Number(col.rows[0]?.v ?? 0),
      expenses_minor: Number(ex.v), discounts_minor: Number(bv.d), ledger_scope: 'business' as const,
    };
  });
}
