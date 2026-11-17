import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { requireUuidParam } from '@/server/http/params';
import { publicTenant } from '@/server/domains/storefront-public';

/** GET own booking (checkout page): only the customer who made it. */
export const GET = route({
  auth: 'user',
  handler: async ({ params, user }) => {
    const t = await publicTenant(params.slug!);
    const id = requireUuidParam(params, 'id');
    return {
      data: await withTenant(t.id, async (trx) => {
        const b = await trx.selectFrom('bookings').select(['id', 'number', 'status', 'payment_status', 'starts_at', 'ends_at', 'timezone', 'subtotal_minor', 'discount_minor', 'tax_minor', 'total_minor', 'deposit_due_minor', 'paid_minor', 'currency', 'payment_terms', 'hold_expires_at', 'policy_snapshot', 'customer_user_id'])
          .where('id', '=', id).executeTakeFirst();
        if (!b || b.customer_user_id !== user.userId) throw Errors.notFound('booking');
        // Snapshot name as booked, plus the specialist's current English name for the English UI (LUMA-AUDIT-039).
        const items = await trx.selectFrom('booking_items as i').leftJoin('staff_profiles as sp', 'sp.id', 'i.staff_id')
          .select(['i.id', 'i.service_name_ar', 'i.service_name_en', 'i.staff_name', 'sp.display_name_en as staff_name_en', 'i.starts_at', 'i.ends_at', 'i.duration_min', 'i.line_total_minor', 'i.addons'])
          .where('i.booking_id', '=', id).where('i.superseded_at', 'is', null).orderBy('i.sequence').execute();
        const { customer_user_id: _c, ...rest } = b;
        return { ...rest, items };
      }),
    };
  },
});
