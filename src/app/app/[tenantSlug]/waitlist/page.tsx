import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { featureEnabled, hasCapability } from '@/server/tenancy/access';
import { getT } from '@/i18n/server';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { PlanNeeded } from '@/ui/commerce/PlanNeeded';
import { WaitlistPage } from '@/ui/engagement/WaitlistPage';

export const metadata = { title: 'Waitlist' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['waitlist.manage'])) return <DeniedState />;
  if (!featureEnabled(access, 'feature.waitlist')) {
    const { t } = await getT();
    return <PlanNeeded title={t('engagement.waitlist.title')} message={t('fe.common.plan_needed')} />;
  }
  return <Suspense fallback={<LoadingState rows={5} />}><WaitlistPage /></Suspense>;
}
