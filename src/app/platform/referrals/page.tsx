import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { ReferralsPage } from '@/ui/platform/admin/ReferralsPage';

export const metadata = { title: 'Referrals' };

export default async function Page() {
  if (!(await platformPageCan('platform.referrals.manage'))) return <DeniedState />;
  return <ReferralsPage />;
}
