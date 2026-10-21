import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { featureEnabled, hasCapability } from '@/server/tenancy/access';
import { getT } from '@/i18n/server';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { PlanNeeded } from '@/ui/commerce/PlanNeeded';
import { GroupsPage } from '@/ui/engagement/GroupsPage';

export const metadata = { title: 'Group sessions' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['bookings.view_all', 'bookings.manage'])) return <DeniedState />;
  if (!featureEnabled(access, 'feature.group_sessions')) {
    const { t } = await getT();
    return <PlanNeeded title={t('engagement.groups.title')} message={t('fe.common.plan_needed')} />;
  }
  return <Suspense fallback={<LoadingState rows={5} />}><GroupsPage /></Suspense>;
}
