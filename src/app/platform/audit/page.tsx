import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { PlatformAuditPage } from '@/ui/platform/Audit';

export const metadata = { title: 'Audit log' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await platformPageCan('platform.audit.view'))) return <DeniedState />;
  const sp = await searchParams;
  return <PlatformAuditPage initial={{ sensitive_only: sp.sensitive_only, tenant: sp.tenant }} />;
}
