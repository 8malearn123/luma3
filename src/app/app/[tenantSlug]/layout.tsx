import { clientAccess, requireTenantPage } from '@/server/pages';
import { dashboardMaintenance } from '@/server/domains/platform/settings';
import { DashboardShell } from '@/ui/shell/DashboardShell';
import { MaintenanceScreen } from '@/ui/workspace/MaintenanceScreen';

/** Membership-protected business workspace. Non-members get a 404 (no existence disclosure). */
export default async function TenantLayout({ children, params }: { children: React.ReactNode; params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { user, access } = await requireTenantPage(tenantSlug);
  // Platform maintenance mode locks business dashboards only (LUMA support under a grant still gets in).
  const maintenance = await dashboardMaintenance();
  if (maintenance.on && access.role !== 'support') return <MaintenanceScreen messageAr={maintenance.message_ar} messageEn={maintenance.message_en} slug={access.slug} />;
  return <DashboardShell access={clientAccess(access)} user={{ displayName: user.displayName, isDemo: user.isDemo }}>{children}</DashboardShell>;
}
