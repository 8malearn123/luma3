import { requireTenantPage } from '@/server/pages';
import { featureEnabled, hasCapability } from '@/server/tenancy/access';
import { Alert, DeniedState } from '@/ui/components/feedback';
import { LoomDashboard } from '@/ui/marketing/LoomDashboard';
import { getT } from '@/i18n/server';

export const metadata = { title: 'Loom Marketing' };

/** Loom Marketing dashboard (?tab=summary|plans|recommendations|trends|campaigns|preferences|jobs). */
export default async function MarketingPage({ params, searchParams }: { params: Promise<{ tenantSlug: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { tenantSlug } = await params;
  const { tab } = await searchParams;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['marketing.view', 'marketing.manage'])) return <DeniedState />;
  if (!featureEnabled(access, 'feature.marketing_ai')) {
    const { t } = await getT();
    return <Alert tone="info">{t('marketing.ai.feature_off')}</Alert>;
  }
  return <LoomDashboard initialTab={tab} />;
}
