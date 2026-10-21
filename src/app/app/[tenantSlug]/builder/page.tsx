import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState } from '@/ui/components/feedback';
import { BuilderLoader } from '@/ui/builder/BuilderApp';

export const metadata = { title: 'Storefront builder' };

/** Storefront builder (builder.edit to edit; builder.publish to publish/rollback — enforced by the API). */
export default async function BuilderPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['builder.edit', 'builder.publish'])) return <DeniedState />;
  return <BuilderLoader slug={tenantSlug} />;
}
