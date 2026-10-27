import { sql } from 'kysely';
import { withSystem } from '../../db/client';
import { notifyCapability } from '../../infra/notify';
import { formatMoney } from '@/shared/format';

/**
 * Bills that were not closed. A visit is "closed" when its service state is
 * final and what was charged has been collected. Two cases are flagged:
 *  - `not_closed`: checked in / in service, but its end passed more than
 *    NOT_CLOSED_GRACE_MIN ago without being completed (bookings.manage);
 *  - `unpaid`: completed with a balance still due, total > paid
 *    (payments.collect).
 * Each booking is flagged once per case (notifications are unique on
 * (user_id, dedupe_key)); only visits from the last LOOKBACK_DAYS are swept
 * so a first run does not flood the bell with old history.
 */
export const NOT_CLOSED_GRACE_MIN = 60;
export const UNPAID_GRACE_MIN = 30;
const LOOKBACK_DAYS = 7;

export type OpenBill = {
  id: string; tenant_id: string; slug: string; number: string; customer: string;
  reason: 'not_closed' | 'unpaid'; due_minor: number; currency: string;
};

export async function findOpenBills(now = new Date()): Promise<OpenBill[]> {
  return withSystem('sweep bookings whose bill was not closed', async (trx) => {
    const rows = await trx.selectFrom('bookings as b')
      .innerJoin('tenants as t', 't.id', 'b.tenant_id')
      .innerJoin('tenant_customers as c', 'c.id', 'b.tenant_customer_id')
      .select(['b.id', 'b.tenant_id', 't.slug', 'b.number', 'c.display_name', 'b.status', 'b.total_minor', 'b.paid_minor', 'b.currency'])
      .where('b.ends_at', '>', sql<Date>`${now}::timestamptz - make_interval(days => ${LOOKBACK_DAYS})`)
      .where((eb) => eb.or([
        eb.and([eb('b.status', 'in', ['checked_in', 'in_service']), eb('b.ends_at', '<', sql<Date>`${now}::timestamptz - make_interval(mins => ${NOT_CLOSED_GRACE_MIN})`)]),
        eb.and([eb('b.status', '=', 'completed'), eb('b.paid_minor', '<', eb.ref('b.total_minor')), eb('b.updated_at', '<', sql<Date>`${now}::timestamptz - make_interval(mins => ${UNPAID_GRACE_MIN})`)]),
      ]))
      .limit(2000).execute();
    return rows.map((r) => ({
      id: r.id, tenant_id: r.tenant_id, slug: String(r.slug), number: r.number, customer: r.display_name,
      reason: r.status === 'completed' ? 'unpaid' as const : 'not_closed' as const,
      due_minor: Number(r.total_minor) - Number(r.paid_minor), currency: r.currency,
    }));
  });
}

export async function runOpenBillsSweep(now = new Date()) {
  const bills = await findOpenBills(now);
  for (const b of bills) {
    await withSystem('notify about a bill that was not closed', async (trx) => {
      const amountAr = formatMoney(b.due_minor, b.currency, 'ar'), amountEn = formatMoney(b.due_minor, b.currency, 'en');
      const n = b.reason === 'unpaid'
        ? {
          title_ar: `فاتورة غير مغلقة: ${b.number}`, title_en: `Unsettled bill: ${b.number}`,
          body_ar: `اكتملت زيارة ${b.customer} وما زال المتبقي ${amountAr} دون تحصيل.`,
          body_en: `${b.customer}'s visit is completed but ${amountEn} is still due.`,
        }
        : {
          title_ar: `زيارة لم تُغلق: ${b.number}`, title_en: `Visit not closed: ${b.number}`,
          body_ar: `انتهى موعد ${b.customer} ولم تُسجَّل الزيارة كمكتملة، فالفاتورة ما زالت مفتوحة.`,
          body_en: `${b.customer}'s appointment has ended but the visit was not completed, so its bill is still open.`,
        };
      await notifyCapability(trx, b.tenant_id, [b.reason === 'unpaid' ? 'payments.collect' : 'bookings.manage'], {
        kind: `finance.open_bill.${b.reason}`, ...n,
        target_path: `/app/${b.slug}/bookings?booking=${b.id}`,
        data: { booking_id: b.id, reason: b.reason, due_minor: b.due_minor },
        dedupe_key: `open_bill:${b.reason}:${b.id}`,
      });
    });
  }
  return { flagged: bills.length };
}
