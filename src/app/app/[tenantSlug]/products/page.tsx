import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { featureEnabled, hasCapability } from '@/server/tenancy/access';
import { getT } from '@/i18n/server';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { PlanNeeded } from '@/ui/commerce/PlanNeeded';
import { ProductsPage } from '@/ui/commerce/ProductsPage';

export const metadata = { title: 'Products' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['catalog.edit', 'inventory.manage', 'inventory.view', 'orders.manage'])) return <DeniedState />;
  if (!featureEnabled(access, 'feature.products')) {
    const { t } = await getT();
    return <PlanNeeded title={t('commerce.products.title')} message={t('commerce.products.plan_needed')} />;
  }
  return <Suspense fallback={<LoadingState rows={5} />}><ProductsPage /></Suspense>;
}
