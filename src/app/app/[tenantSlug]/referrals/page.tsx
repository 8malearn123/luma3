import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState } from '@/ui/components/feedback';
import { ReferralPage } from '@/ui/workspace/ReferralPage';

export const metadata = { title: 'Referrals' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['business.manage'])) return <DeniedState />;
  return <ReferralPage />;
}
