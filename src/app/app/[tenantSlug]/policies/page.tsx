import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState } from '@/ui/components/feedback';
import { PoliciesPage } from '@/ui/policy/PoliciesPage';
import { StepUpProvider } from '@/ui/policy/StepUp';

export const metadata = { title: 'Incidents & policy' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['incidents.submit', 'incidents.review'])) return <DeniedState />;
  return <StepUpProvider><PoliciesPage /></StepUpProvider>;
}
