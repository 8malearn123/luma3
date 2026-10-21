import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { featureEnabled, hasCapability } from '@/server/tenancy/access';
import { getT } from '@/i18n/server';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { PlanNeeded } from '@/ui/commerce/PlanNeeded';
import { InventoryPage } from '@/ui/commerce/InventoryPage';

export const metadata = { title: 'Inventory' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['inventory.view', 'inventory.manage'])) return <DeniedState />;
  if (!featureEnabled(access, 'feature.inventory')) {
    const { t } = await getT();
    return <PlanNeeded title={t('commerce.inventory.title')} message={t('commerce.inventory.plan_needed')} />;
  }
  return <Suspense fallback={<LoadingState rows={5} />}><InventoryPage /></Suspense>;
}
