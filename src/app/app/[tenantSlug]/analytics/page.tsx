import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState } from '@/ui/components/feedback';
import { AnalyticsDashboard } from '@/ui/analytics/AnalyticsDashboard';

export const metadata = { title: 'Analytics' };

/** Storefront analytics, service demand, occupancy and team indicators (?tab=store|demand|occupancy|team). */
export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ tenantSlug: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { tenantSlug } = await params;
  const { tab } = await searchParams;
  const { access } = await requireTenantPage(tenantSlug);
  const ownOnly = !!access.staffProfileId && hasCapability(access, 'schedule.view_own');
  if (!hasCapability(access, 'analytics.view') && !ownOnly) return <DeniedState />;
  return <AnalyticsDashboard initialTab={hasCapability(access, 'analytics.view') ? tab : 'team'} />;
}
