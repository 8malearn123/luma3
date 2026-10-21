import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { BookingsPage } from '@/ui/bookings/BookingsPage';

export const metadata = { title: 'Bookings' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['bookings.view_all', 'bookings.view_assigned', 'bookings.view_financial'])) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><BookingsPage /></Suspense>;
}
