import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { TenantsPage } from '@/ui/platform/Tenants';

export const metadata = { title: 'Businesses' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await platformPageCan('platform.tenants.view'))) return <DeniedState />;
  const sp = await searchParams;
  return <TenantsPage initialQ={sp.q ?? ''} />;
}
