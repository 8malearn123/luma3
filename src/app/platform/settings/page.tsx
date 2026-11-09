import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { PlatformSettingsPage } from '@/ui/platform/admin/SettingsPage';

export const metadata = { title: 'Platform settings' };

export default async function Page() {
  if (!(await platformPageCan('platform.settings.manage'))) return <DeniedState />;
  return <PlatformSettingsPage />;
}
