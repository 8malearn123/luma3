import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { UsersPage } from '@/ui/platform/Users';

export const metadata = { title: 'Users & roles' };

export default async function Page() {
  if (!(await platformPageCan('platform.users.manage'))) return <DeniedState />;
  return <UsersPage />;
}
