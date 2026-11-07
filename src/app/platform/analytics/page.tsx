import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { AnalyticsPage } from '@/ui/platform/admin/AnalyticsPage';

export const metadata = { title: 'Analytics' };

export default async function Page() {
  if (!(await platformPageCan('platform.analytics.view'))) return <DeniedState />;
  return <AnalyticsPage />;
}
