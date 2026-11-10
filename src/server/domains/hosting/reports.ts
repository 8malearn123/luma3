import { sql } from 'kysely';
import { withTenant } from '../../db/client';
import type { TenantAccess } from '../../tenancy/access';
import { listForGuest, listForHost } from './bookings';

/**
 * Hosting money summaries from the journal (one source of truth) plus open
 * items. Host: hosting revenue, product add-on sales, receivables, refunds,
 * settlements. Guest: hosting expenses, dues, spend per host.
 */
async function balance(access: TenantAccess, account: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.selectFrom('financial_entries').select(sql<number>`coalesce(sum(credit_minor - debit_minor), 0)::bigint`.as('n'))
      .where('account', '=', account as never).where('ref_type', 'like', 'workspace_%').executeTakeFirstOrThrow();
    return Number(r.n);
  });
}

export async function hostSummary(access: TenantAccess) {
  const bookings = await withTenant(access.tenantId, (trx) => listForHost(trx, access.tenantId));
  return {
    hosting_revenue_minor: await balance(access, 'hosting_revenue'),
    product_addon_sales_minor: await balance(access, 'product_revenue'),
    receivable_minor: -(await balance(access, 'hosting_receivable')),
    refunds_minor: -(await balance(access, 'refunds')),
    counts: {
      awaiting_approval: bookings.filter((b) => b.status === 'pending_approval').length,
      upcoming: bookings.filter((b) => ['confirmed', 'checked_in', 'in_use'].includes(b.status)).length,
      to_settle: bookings.filter((b) => ['completed', 'cancelled', 'no_show'].includes(b.status) && ['open', 'corrected'].includes(b.settlement_status)).length,
    },
    platform_fee: { enabled: false, amount_minor: 0, note: 'D11: included in the subscription; the fee structure exists with value 0 and is disabled.' },
    basis: 'Journal entries posted by space bookings only. The expert\'s client service revenue is never recorded here.',
  };
}

export async function guestSummary(access: TenantAccess) {
  const bookings = await withTenant(access.tenantId, (trx) => listForGuest(trx, access.tenantId));
  const perHost = new Map<string, { host: string; total_minor: number; count: number }>();
  for (const b of bookings.filter((x) => ['confirmed', 'checked_in', 'in_use', 'completed', 'no_show', 'cancelled'].includes(x.status) && x.paid_minor > 0)) {
    const name = (b.host as { name?: string }).name ?? '';
    const cur = perHost.get(name) ?? { host: name, total_minor: 0, count: 0 };
    cur.total_minor += b.paid_minor - b.refunded_minor; cur.count += 1;
    perHost.set(name, cur);
  }
  return {
    hosting_expense_minor: -(await balance(access, 'hosting_expense')),
    dues_minor: await balance(access, 'hosting_payable'),
    per_host: [...perHost.values()].sort((a, b) => b.total_minor - a.total_minor),
    basis: 'Journal entries posted by your space bookings (rent and add-ons paid to host salons).',
  };
}
