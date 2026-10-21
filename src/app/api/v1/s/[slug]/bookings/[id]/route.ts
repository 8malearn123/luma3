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
        const items = await trx.selectFrom('booking_items').select(['id', 'service_name_ar', 'service_name_en', 'staff_name', 'starts_at', 'ends_at', 'duration_min', 'line_total_minor', 'addons'])
          .where('booking_id', '=', id).where('superseded_at', 'is', null).orderBy('sequence').execute();
        const { customer_user_id: _c, ...rest } = b;
        return { ...rest, items };
      }),
    };
  },
});
