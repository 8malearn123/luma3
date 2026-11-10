import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { LoomSettingsPage } from '@/ui/platform/admin/LoomSettingsPage';
import { LoomCalendarAdmin } from '@/ui/platform/admin/LoomCalendarAdmin';
import { LoomExternalBusinesses } from '@/ui/platform/admin/LoomExternalBusinesses';

export const metadata = { title: 'Loom Marketing' };

/** Loom platform settings (platform owner; MFA by the platform layout; step-up on save). */
export default async function Page() {
  if (!(await platformPageCan('platform.loom.manage'))) return <DeniedState />;
  return <div className="flex flex-col gap-6"><LoomSettingsPage /><LoomCalendarAdmin /><LoomExternalBusinesses /></div>;
}
