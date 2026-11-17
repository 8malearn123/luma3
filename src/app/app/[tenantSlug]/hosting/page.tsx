import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { areaAvailable } from '@/server/tenancy/workspace-mode';
import { NotAvailable } from '@/ui/expert/NotAvailable';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { HostingPage } from '@/ui/hosting/HostingPage';

export const metadata = { title: 'Spaces & hosting' };

/** «المساحات والاستضافة»: the salon offers chairs/rooms to independent experts. */
export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  // Hidden for this business type (workspace-mode.ts): a direct URL shows «غير متاح», the API refuses too.
  if (!areaAvailable(access, 'hosting')) return <NotAvailable area="hosting" />;
  if (!hasCapability(access, ['hosting.view', 'hosting.manage'])) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><HostingPage /></Suspense>;
}
