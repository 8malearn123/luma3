import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState } from '@/ui/components/feedback';
import { DigestList } from '@/ui/business/Digest';

export const metadata = { title: 'Weekly digest' };

/** Weekly owner digests (latest first). */
export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['business.manage', 'analytics.view'])) return <DeniedState />;
  return <DigestList />;
}
