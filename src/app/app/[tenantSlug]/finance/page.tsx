import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { FinancePage } from '@/ui/finance/FinancePage';

export const metadata = { title: 'Finance' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { user, access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['finance.view'])) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><FinancePage demo={!!user.isDemo} /></Suspense>;
}
