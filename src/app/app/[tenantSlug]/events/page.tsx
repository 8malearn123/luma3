import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { EventsPage } from '@/ui/expert/EventsPage';

export const metadata = { title: 'Event bookings' };

/** Event bookings with a deposit («حجوزات المناسبات»): requests, quotes and confirmed events. */
export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['bookings.view_all', 'bookings.manage'])) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><EventsPage /></Suspense>;
}
