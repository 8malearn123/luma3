import { OnboardingWizard } from '@/ui/workspace/OnboardingWizard';
import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState } from '@/ui/components/feedback';

export const metadata = { title: 'Setup' };

export default async function OnboardingPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, 'business.manage')) return <DeniedState />;
  return <OnboardingWizard slug={tenantSlug} />;
}
