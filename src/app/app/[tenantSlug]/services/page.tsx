import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { ServicesPage } from '@/ui/catalog/ServicesPage';

export const metadata = { title: 'Services' };

/** Service catalog (tabs via ?tab=: services, packages, resources, proposals; editor via ?service=<id|new>). */
export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, 'catalog.edit')) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><ServicesPage /></Suspense>;
}
