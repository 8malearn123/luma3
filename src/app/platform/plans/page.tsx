import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { PlansPage } from '@/ui/platform/Plans';

export const metadata = { title: 'Plans' };

export default async function Page() {
  if (!(await platformPageCan('platform.tenants.view'))) return <DeniedState />;
  return <PlansPage />;
}
