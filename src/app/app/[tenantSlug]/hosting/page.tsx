import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { HostingPage } from '@/ui/hosting/HostingPage';

export const metadata = { title: 'Spaces & hosting' };

/** «المساحات والاستضافة»: the salon offers chairs/rooms to independent experts. */
export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['hosting.view', 'hosting.manage'])) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><HostingPage /></Suspense>;
}
