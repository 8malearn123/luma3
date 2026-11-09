import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { FeedPage } from '@/ui/platform/admin/Feed';

export const metadata = { title: 'Live activity' };

export default async function Page() {
  if (!(await platformPageCan('platform.feed.view'))) return <DeniedState />;
  return <FeedPage />;
}
