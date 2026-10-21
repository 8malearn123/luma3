import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { RevenuePage } from '@/ui/platform/Reports';

export const metadata = { title: 'Revenue' };

export default async function Page() {
  if (!(await platformPageCan('platform.revenue.view'))) return <DeniedState />;
  return <RevenuePage />;
}
