import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState } from '@/ui/components/feedback';
import { SettingsPage } from '@/ui/settings/SettingsPage';

export const metadata = { title: 'Settings' };

/** Business settings (tabs: profile, branches, booking policy, payments link, subscription, notifications, display, legal & tax). */
export default async function Page({ params, searchParams }: { params: Promise<{ tenantSlug: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['business.manage', 'payments.configure', 'subscription.view', 'subscription.manage', 'schedule.manage'])) return <DeniedState />;
  const { tab } = await searchParams;
  return <SettingsPage initialTab={tab} />;
}
