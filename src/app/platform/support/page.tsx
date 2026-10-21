import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { SupportPage } from '@/ui/platform/Support';

export const metadata = { title: 'Support access' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await platformPageCan('platform.support.access'))) return <DeniedState />;
  const sp = await searchParams;
  return <SupportPage initialTenant={sp.tenant ?? ''} />;
}
