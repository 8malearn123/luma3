import { notFound } from 'next/navigation';
import { withTenant } from '@/server/db/client';
import { publicTenant } from '@/server/domains/storefront-public';
import { getSessionUser } from '@/server/pages';
import { AppError } from '@/server/http/errors';
import { badgeOf } from '@/shared/badges';
import { BookingFlow, type FlowService } from '@/ui/booking/BookingFlow';
import { rebookPrefill } from '@/server/domains/booking/rebook';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false } };

/** Public booking flow. Only allowlisted catalog fields reach the browser (no costs, no internal notes). */
export default async function BookingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ service?: string; staff?: string; package?: string; branch?: string; rebook?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  let tenant;
  try { tenant = await publicTenant(slug); } catch (e) { if (e instanceof AppError) notFound(); throw e; }
  const data = await withTenant(tenant.id, async (trx) => {
    const services = await trx.selectFrom('services as s').leftJoin('categories as c', 'c.id', 's.category_id')
      .select(['s.id', 's.name_ar', 's.name_en', 's.description_ar', 's.description_en', 's.price_minor', 's.price_display', 's.duration_min', 's.category_id', 'c.name_ar as category_ar', 'c.name_en as category_en', 'c.sort as category_sort', 's.sort', 's.branch_id', 's.badge_kind', 's.badge_text_ar', 's.badge_text_en'])
      .where('s.is_active', '=', true).where('s.is_visible', '=', true).where('s.archived_at', 'is', null).where('s.booking_mode', '=', 'individual')
      .where((eb) => eb.or([eb('s.category_id', 'is', null), eb.and([eb('c.is_visible', '=', true), eb('c.archived_at', 'is', null)])]))
      .orderBy('c.sort').orderBy('s.sort').execute();
    const links = services.length ? await trx.selectFrom('service_staff as ss').innerJoin('staff_profiles as sp', 'sp.id', 'ss.staff_id')
      .select(['ss.service_id', 'sp.id', 'sp.display_name', 'sp.display_name_en', 'sp.title_ar', 'sp.title_en', 'sp.photo_asset_id'])
      .where('ss.service_id', 'in', services.map((s) => s.id)).where('sp.is_active', '=', true).where('sp.is_public', '=', true).where('sp.archived_at', 'is', null).execute() : [];
    // Branch picker: offered only when the business has more than one active branch.
    const branches = await trx.selectFrom('branches').select(['id', 'name', 'city', 'is_primary']).where('status', '=', 'active').orderBy('is_primary', 'desc').orderBy('created_at').execute();
    const assignments = links.length ? await trx.selectFrom('staff_branch_assignments').select(['staff_id', 'branch_id']).where('staff_id', 'in', [...new Set(links.map((l) => l.id))]).execute() : [];
    const settings = await trx.selectFrom('tenant_settings').select(['hold_ttl_sec', 'free_cancellation_hours', 'late_cancellation_fee_bp', 'time_format']).where('tenant_id', '=', tenant.id).executeTakeFirstOrThrow();
    return { services, links, settings, branches, assignments };
  });
  const services: FlowService[] = data.services.map((s) => ({
    id: s.id, name_ar: s.name_ar, name_en: s.name_en, description_ar: s.description_ar, description_en: s.description_en, price_minor: s.price_minor, price_display: s.price_display,
    duration_min: s.duration_min, badge: badgeOf(s), category: s.category_id ? { id: s.category_id, name_ar: s.category_ar, name_en: s.category_en } : null, branch_id: s.branch_id,
    staff: data.links.filter((l) => l.service_id === s.id).map((l) => ({
      id: l.id, name: l.display_name, name_en: l.display_name_en, title_ar: l.title_ar, title_en: l.title_en, photo: l.photo_asset_id,
      branch_ids: data.assignments.filter((a) => a.staff_id === l.id).map((a) => a.branch_id),
    })),
  }));
  const user = await getSessionUser().catch(() => null);
  // «إعادة الحجز»: same services and specialists from one of her bookings; she picks the new time.
  const rebook = sp.rebook && user ? await rebookPrefill(user.userId, sp.rebook).catch(() => null) : null;
  const prefill = rebook && rebook.tenant_slug === slug ? rebook : null;
  const branches = data.branches.length > 1 ? data.branches.map((b) => ({ id: b.id, name: b.name, city: b.city })) : [];
  const branchId = branches.length ? (branches.find((b) => b.id === (prefill?.branch_id ?? sp.branch))?.id ?? branches[0]!.id) : null;
  return (
    <BookingFlow slug={slug} tenantName={tenant.name} timezone={tenant.timezone} services={services} signedIn={!!user} verified={!!user && (user.emailVerified || user.phoneVerified)}
      policy={{ holdMin: Math.round(data.settings.hold_ttl_sec / 60), freeHours: data.settings.free_cancellation_hours, lateFeeBp: data.settings.late_cancellation_fee_bp }}
      initial={{ serviceId: sp.service ?? null, staffId: sp.staff ?? null, picks: prefill ? prefill.items.filter((i) => !i.unavailable).map((i) => ({ serviceId: i.service_id, staffId: i.staff_id })) : null, branchId }}
      branches={branches} rebooking={!!prefill} />
  );
}
