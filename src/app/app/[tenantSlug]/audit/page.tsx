import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState } from '@/ui/components/feedback';
import { TenantAuditPage } from '@/ui/settings/TenantAudit';

export const metadata = { title: 'Audit log' };

export default async function Page({ params, searchParams }: { params: Promise<{ tenantSlug: string }>; searchParams: Promise<{ support_only?: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, 'audit.view')) return <DeniedState />;
  const { support_only } = await searchParams;
  return <TenantAuditPage initialSupportOnly={support_only === '1'} />;
}
