import { requirePlatformPage } from '@/server/domains/platform/page-guard';
import { SecurityPage } from '@/ui/platform/Security';

export const metadata = { title: 'Security' };

export default async function Page() {
  await requirePlatformPage();
  return <SecurityPage />;
}
