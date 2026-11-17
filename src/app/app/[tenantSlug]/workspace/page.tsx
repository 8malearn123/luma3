import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { featureEnabled, hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { WorkspacePage } from '@/ui/hosting/WorkspacePage';

export const metadata = { title: 'Book a workspace' };

/** «احجزي مساحة عمل»: an independent expert books a chair or room at a salon. */
export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (access.businessType !== 'expert' || !hasCapability(access, 'workspace.book') || !featureEnabled(access, 'workspace.book')) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><WorkspacePage /></Suspense>;
}
