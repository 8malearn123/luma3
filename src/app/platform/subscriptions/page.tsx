import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { SubscriptionsPage } from '@/ui/platform/Subscriptions';

export const metadata = { title: 'Subscriptions' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await platformPageCan('platform.tenants.view'))) return <DeniedState />;
  const sp = await searchParams;
  return <SubscriptionsPage initial={{ status: sp.status, q: sp.q }} />;
}
