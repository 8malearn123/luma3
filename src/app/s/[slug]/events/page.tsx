import { notFound } from 'next/navigation';
import { DateTime } from 'luxon';
import { getSessionUser } from '@/server/pages';
import { getLocale } from '@/i18n/server';
import { pick } from '@/i18n';
import { EventRequestView } from '@/ui/storefront/EventViews';
import { loadStorefront } from '../_data';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Event bookings' };

/** Public event booking request form («حجوزات المناسبات»). */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await loadStorefront(slug);
  if (!data || !data.events?.enabled) notFound();
  const user = await getSessionUser().catch(() => null);
  const locale = await getLocale();
  const services = data.catalog.services.filter((s) => s.bookable).map((s) => ({ id: s.id, name_ar: s.name_ar, name_en: s.name_en }));
  const minDate = DateTime.now().setZone(data.tenant.timezone).plus({ days: 1 }).toISODate()!;
  return (
    <EventRequestView slug={slug} services={services} maxPeople={data.events.max_people} freeCancellationDays={data.events.free_cancellation_days}
      intro={pick(locale, data.events.intro_ar, data.events.intro_en) || null} signedIn={!!user} verified={!!user && (user.emailVerified || user.phoneVerified)} minDate={minDate} />
  );
}
