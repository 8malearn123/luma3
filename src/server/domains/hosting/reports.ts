import { sql } from 'kysely';
import { withTenant } from '../../db/client';
import type { TenantAccess } from '../../tenancy/access';
import { listForHost } from './bookings';
import { hostingTx } from './scope';

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

/**
 * The expert's hosting expense from HER journal (one source of truth), split per
 * space booking by mapping each posting back to the booking it came from:
 * payments (rent/add-ons, dues), extra-charge lines and refunds. The per-salon
 * figures therefore always add up to the total (LUMA-AUDIT-037: the per-salon
 * list used to be paid−refunded, a cash figure, while the total was accrual).
 */
export async function guestExpenseByBooking(guestTenantId: string) {
  return hostingTx('expert reads her hosting expense per space booking', async (trx) => {
    const wbs = await trx.selectFrom('workspace_bookings').select(['id', 'number', 'host_snapshot', 'host_tenant_id']).where('guest_tenant_id', '=', guestTenantId).execute();
    const refToBooking = new Map<string, string>();
    if (wbs.length) {
      const ids = wbs.map((w) => w.id);
      const pays = await trx.selectFrom('payments').select(['id', 'workspace_booking_id']).where('workspace_booking_id', 'in', ids).execute();
      for (const p of pays) refToBooking.set(p.id, p.workspace_booking_id!);
      const lines = await trx.selectFrom('workspace_booking_lines').select(['id', 'workspace_booking_id']).where('workspace_booking_id', 'in', ids).execute();
      for (const l of lines) refToBooking.set(l.id, l.workspace_booking_id);
      if (pays.length) {
        const refunds = await trx.selectFrom('refunds').select(['id', 'payment_id']).where('payment_id', 'in', pays.map((p) => p.id)).execute();
        for (const r of refunds) refToBooking.set(r.id, refToBooking.get(r.payment_id)!);
      }
    }
    const entries = await trx.selectFrom('financial_entries').select(['ref_id', sql<number>`sum(debit_minor - credit_minor)::bigint`.as('n')])
      .where('tenant_id', '=', guestTenantId).where('account', '=', 'hosting_expense').where('ref_type', 'like', 'workspace_%').groupBy('ref_id').execute();
    const perBooking = new Map<string, number>();
    let unmapped = 0;
    for (const e of entries) {
      const wb = e.ref_id ? refToBooking.get(e.ref_id) : undefined;
      if (wb) perBooking.set(wb, (perBooking.get(wb) ?? 0) + Number(e.n));
      else unmapped += Number(e.n);
    }
    return { bookings: wbs, perBooking, unmapped, total: entries.reduce((a, e) => a + Number(e.n), 0) };
  });
}

export async function guestSummary(access: TenantAccess) {
  const x = await guestExpenseByBooking(access.tenantId);
  const perHost = new Map<string, { host: string; total_minor: number; count: number }>();
  for (const w of x.bookings) {
    const amount = x.perBooking.get(w.id);
    if (amount === undefined) continue;
    const name = (w.host_snapshot as { name?: string }).name ?? '';
    const cur = perHost.get(w.host_tenant_id) ?? { host: name, total_minor: 0, count: 0 };
    cur.total_minor += amount; cur.count += 1;
    perHost.set(w.host_tenant_id, cur);
  }
  return {
    hosting_expense_minor: x.total,
    dues_minor: await balance(access, 'hosting_payable'),
    per_host: [...perHost.values()].sort((a, b) => b.total_minor - a.total_minor),
    unmapped_minor: x.unmapped,
    basis: 'Journal entries posted by your space bookings (rent, add-ons, approved fees and corrections, less refunds), tax included as charged by the salon. Accrual: unpaid dues are included and also shown as dues.',
  };
}
