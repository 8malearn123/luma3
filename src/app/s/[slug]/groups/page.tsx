import { notFound } from 'next/navigation';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';
import { listSessions } from '@/server/domains/groups/service';
import { getSessionUser } from '@/server/pages';
import { AppError } from '@/server/http/errors';
import { getLocale } from '@/i18n/server';
import { formatDateTime } from '@/shared/format';
import { GroupSessionsList } from '@/ui/storefront/EngagementViews';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Group sessions' };

function nextSixtyDays() {
  const now = Date.now();
  return { from: new Date(now), to: new Date(now + 60 * 86_400_000) };
}

/** Public list of upcoming group sessions (same allowlisted fields as the public API). */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let tenant;
  try {
    tenant = await publicTenant(slug);
    await requirePublicFeature(tenant.id, 'feature.group_sessions');
  } catch (e) { if (e instanceof AppError) notFound(); throw e; }
  const rows = await listSessions(tenant.id, { ...nextSixtyDays(), publicOnly: true });
  const user = await getSessionUser().catch(() => null);
  const locale = await getLocale();
  const sessions = rows.map((r) => ({
    id: r.id, title_ar: r.title_ar, title_en: r.title_en, starts_at: r.starts_at.toISOString(), ends_at: r.ends_at.toISOString(),
    when_label: formatDateTime(r.starts_at, { tz: tenant.timezone, locale, timeFormat: user?.timeFormat ?? '12h', weekday: true }),
    capacity: r.capacity, seats_left: r.capacity - r.seats_taken, price_minor: r.price_minor, staff_name: r.staff_name,
  }));
  return <GroupSessionsList slug={slug} sessions={sessions} timezone={tenant.timezone} currency={tenant.currency ?? 'SAR'} signedIn={!!user} verified={!!user && (user.emailVerified || user.phoneVerified)} />;
}
