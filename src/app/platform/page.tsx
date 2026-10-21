import { requirePlatformPage } from '@/server/domains/platform/page-guard';
import { PlatformOverview } from '@/ui/platform/Overview';

export const metadata = { title: 'Overview' };

export default async function Page() {
  await requirePlatformPage();
  return <PlatformOverview />;
}
