import { notFound } from 'next/navigation';
import { withTenant } from '@/server/db/client';
import { publicTenant } from '@/server/domains/storefront-public';
import { getSessionUser } from '@/server/pages';
import { AppError } from '@/server/http/errors';
import { BookingFlow, type FlowService } from '@/ui/booking/BookingFlow';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false } };

/** Public booking flow. Only allowlisted catalog fields reach the browser (no costs, no internal notes). */
export default async function BookingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ service?: string; staff?: string; package?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  let tenant;
  try { tenant = await publicTenant(slug); } catch (e) { if (e instanceof AppError) notFound(); throw e; }
  const data = await withTenant(tenant.id, async (trx) => {
    const services = await trx.selectFrom('services as s').leftJoin('categories as c', 'c.id', 's.category_id')
      .select(['s.id', 's.name_ar', 's.name_en', 's.description_ar', 's.description_en', 's.price_minor', 's.price_display', 's.duration_min', 's.category_id', 'c.name_ar as category_ar', 'c.name_en as category_en', 'c.sort as category_sort', 's.sort'])
      .where('s.is_active', '=', true).where('s.is_visible', '=', true).where('s.archived_at', 'is', null).where('s.booking_mode', '=', 'individual')
      .where((eb) => eb.or([eb('s.category_id', 'is', null), eb.and([eb('c.is_visible', '=', true), eb('c.archived_at', 'is', null)])]))
      .orderBy('c.sort').orderBy('s.sort').execute();
    const links = services.length ? await trx.selectFrom('service_staff as ss').innerJoin('staff_profiles as sp', 'sp.id', 'ss.staff_id')
      .select(['ss.service_id', 'sp.id', 'sp.display_name', 'sp.display_name_en', 'sp.title_ar', 'sp.title_en', 'sp.photo_asset_id'])
      .where('ss.service_id', 'in', services.map((s) => s.id)).where('sp.is_active', '=', true).where('sp.is_public', '=', true).where('sp.archived_at', 'is', null).execute() : [];
    const settings = await trx.selectFrom('tenant_settings').select(['hold_ttl_sec', 'free_cancellation_hours', 'late_cancellation_fee_bp', 'time_format']).where('tenant_id', '=', tenant.id).executeTakeFirstOrThrow();
    return { services, links, settings };
  });
  const services: FlowService[] = data.services.map((s) => ({
    id: s.id, name_ar: s.name_ar, name_en: s.name_en, description_ar: s.description_ar, description_en: s.description_en, price_minor: s.price_minor, price_display: s.price_display,
    duration_min: s.duration_min, category: s.category_id ? { id: s.category_id, name_ar: s.category_ar, name_en: s.category_en } : null,
    staff: data.links.filter((l) => l.service_id === s.id).map((l) => ({ id: l.id, name: l.display_name, name_en: l.display_name_en, title_ar: l.title_ar, title_en: l.title_en, photo: l.photo_asset_id })),
  }));
  const user = await getSessionUser().catch(() => null);
  return (
    <BookingFlow slug={slug} tenantName={tenant.name} timezone={tenant.timezone} services={services} signedIn={!!user} verified={!!user && (user.emailVerified || user.phoneVerified)}
      policy={{ holdMin: Math.round(data.settings.hold_ttl_sec / 60), freeHours: data.settings.free_cancellation_hours, lateFeeBp: data.settings.late_cancellation_fee_bp }}
      initial={{ serviceId: sp.service ?? null, staffId: sp.staff ?? null }} />
  );
}
