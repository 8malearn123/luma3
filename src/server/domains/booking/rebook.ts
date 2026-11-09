import { withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { customerBookingTenant } from './customer';

const REBOOKABLE = new Set(['completed', 'confirmed', 'checked_in', 'in_service', 'cancelled', 'no_show', 'expired', 'pending_approval']);

/**
 * «إعادة الحجز»: the same services with the same specialists from one of her
 * bookings; she then picks a new time in the normal booking flow (every check —
 * availability, hold, payment terms — runs again there).
 *
 * Only what is still publicly bookable is prefilled: a service that is no
 * longer offered is dropped (`unavailable`), and a specialist who no longer
 * offers it at that branch is replaced by "any specialist" (`staff_id: null`).
 */
export async function rebookPrefill(userId: string, bookingId: string) {
  const ref = await customerBookingTenant(userId, bookingId);
  return withTenant(ref.tenant_id, async (trx) => {
    const b = await trx.selectFrom('bookings').select(['id', 'status', 'branch_id', 'customer_user_id']).where('id', '=', bookingId).executeTakeFirst();
    if (!b || b.customer_user_id !== userId) throw Errors.notFound('booking');
    if (!REBOOKABLE.has(b.status)) throw Errors.invalid('not_rebookable', 'This booking cannot be booked again');
    const branch = await trx.selectFrom('branches').select(['id', 'status']).where('id', '=', b.branch_id).executeTakeFirst();
    const branchId = branch?.status === 'active' ? branch.id : null;
    const items = await trx.selectFrom('booking_items').select(['service_id', 'staff_id', 'service_name_ar', 'service_name_en', 'staff_name'])
      .where('booking_id', '=', bookingId).where('superseded_at', 'is', null).orderBy('sequence').execute();
    const ids = [...new Set(items.map((i) => i.service_id))];
    const services = ids.length ? await trx.selectFrom('services as s').leftJoin('categories as c', 'c.id', 's.category_id')
      .select(['s.id', 's.branch_id']).where('s.id', 'in', ids).where('s.is_active', '=', true).where('s.is_visible', '=', true).where('s.archived_at', 'is', null)
      .where('s.booking_mode', '=', 'individual')
      .where((eb) => eb.or([eb('s.category_id', 'is', null), eb.and([eb('c.is_visible', '=', true), eb('c.archived_at', 'is', null)])])).execute() : [];
    const links = ids.length && branchId ? await trx.selectFrom('service_staff as ss').innerJoin('staff_profiles as sp', 'sp.id', 'ss.staff_id')
      .innerJoin('staff_branch_assignments as sba', (j) => j.onRef('sba.staff_id', '=', 'ss.staff_id').on('sba.branch_id', '=', branchId))
      .select(['ss.service_id', 'ss.staff_id']).where('ss.service_id', 'in', ids)
      .where('sp.is_active', '=', true).where('sp.is_public', '=', true).where('sp.archived_at', 'is', null).execute() : [];
    const out = items.map((i) => {
      const s = services.find((x) => x.id === i.service_id && (!x.branch_id || x.branch_id === branchId));
      const staffOk = links.some((l) => l.service_id === i.service_id && l.staff_id === i.staff_id);
      return {
        service_id: i.service_id, service_name_ar: i.service_name_ar, service_name_en: i.service_name_en,
        staff_id: s && staffOk ? i.staff_id : null, staff_name: i.staff_name, staff_kept: !!s && staffOk, unavailable: !s || !branchId,
      };
    });
    return {
      booking_id: bookingId, tenant_slug: ref.tenant_slug, branch_id: branchId, items: out,
      bookable: out.some((i) => !i.unavailable),
      booking_url: `/s/${ref.tenant_slug}/booking?rebook=${bookingId}`,
    };
  });
}
