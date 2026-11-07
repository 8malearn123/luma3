import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { ActivityPage } from '@/ui/platform/admin/ActivityPage';

export const metadata = { title: 'Bookings & payments' };

export default async function Page() {
  if (!(await platformPageCan('platform.activity.view'))) return <DeniedState />;
  return <ActivityPage />;
}
