import { Suspense } from 'react';
import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { MarketplaceAdminPage } from '@/ui/platform/Marketplace';

export const metadata = { title: 'Marketplace' };

export default async function Page() {
  if (!(await platformPageCan('platform.marketplace.review'))) return <DeniedState />;
  return <Suspense fallback={<LoadingState />}><MarketplaceAdminPage /></Suspense>;
}
