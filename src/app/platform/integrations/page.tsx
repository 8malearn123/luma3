import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { IntegrationsPage } from '@/ui/platform/Monitoring';

export const metadata = { title: 'Integrations' };

export default async function Page() {
  if (!(await platformPageCan('platform.integrations.view'))) return <DeniedState />;
  return <IntegrationsPage />;
}
