import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { TemplatesPage } from '@/ui/platform/Templates';

export const metadata = { title: 'Templates' };

export default async function Page() {
  if (!(await platformPageCan('platform.templates.manage'))) return <DeniedState />;
  return <TemplatesPage />;
}
