import { platformPageCan } from '@/server/domains/platform/page-guard';
import { DeniedState } from '@/ui/components/feedback';
import { AiUsagePage } from '@/ui/platform/Monitoring';

export const metadata = { title: 'AI usage' };

export default async function Page() {
  if (!(await platformPageCan('platform.ai_usage.view'))) return <DeniedState />;
  return <AiUsagePage />;
}
