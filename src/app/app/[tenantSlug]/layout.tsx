import { clientAccess, requireTenantPage } from '@/server/pages';
import { DashboardShell } from '@/ui/shell/DashboardShell';

/** Membership-protected business workspace. Non-members get a 404 (no existence disclosure). */
export default async function TenantLayout({ children, params }: { children: React.ReactNode; params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { user, access } = await requireTenantPage(tenantSlug);
  return <DashboardShell access={clientAccess(access)} user={{ displayName: user.displayName, isDemo: user.isDemo }}>{children}</DashboardShell>;
}
