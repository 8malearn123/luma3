import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { featureEnabled, hasCapability } from '@/server/tenancy/access';
import { getT } from '@/i18n/server';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { PlanNeeded } from '@/ui/commerce/PlanNeeded';
import { OrdersPage } from '@/ui/commerce/OrdersPage';

export const metadata = { title: 'Orders' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['orders.view'])) return <DeniedState />;
  if (!featureEnabled(access, 'feature.products')) {
    const { t } = await getT();
    return <PlanNeeded title={t('commerce.orders.title')} message={t('commerce.products.plan_needed')} />;
  }
  return <Suspense fallback={<LoadingState rows={5} />}><OrdersPage /></Suspense>;
}
