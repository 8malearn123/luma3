import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { PortfolioPage } from '@/ui/expert/PortfolioPage';

export const metadata = { title: 'Portfolio' };

/** Portfolio («أعمالي» for experts): before/after pairs for the storefront. */
export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, 'builder.edit')) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><PortfolioPage /></Suspense>;
}
