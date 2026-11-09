import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { LoomSettingsPage } from '@/ui/platform/admin/LoomSettingsPage';

export const metadata = { title: 'Loom Marketing' };

/** Loom platform settings (platform owner; MFA by the platform layout; step-up on save). */
export default async function Page() {
  if (!(await platformPageCan('platform.loom.manage'))) return <DeniedState />;
  return <LoomSettingsPage />;
}
