import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState } from '@/ui/components/feedback';
import { DigestView } from '@/ui/business/Digest';

export const metadata = { title: 'Weekly digest' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string; id: string }> }) {
  const { tenantSlug, id } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['business.manage', 'analytics.view'])) return <DeniedState />;
  return <DigestView id={id} />;
}
