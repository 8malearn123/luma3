import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { StaffPortal } from '@/ui/staff/StaffPortal';

export const metadata = { title: 'My schedule' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, 'schedule.view_own')) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><StaffPortal /></Suspense>;
}
