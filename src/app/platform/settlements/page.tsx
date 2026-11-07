import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { SettlementsPage } from '@/ui/platform/admin/SettlementsPage';

export const metadata = { title: 'Settlements' };

export default async function Page() {
  if (!(await platformPageCan('platform.settlements.manage'))) return <DeniedState />;
  return <SettlementsPage />;
}
