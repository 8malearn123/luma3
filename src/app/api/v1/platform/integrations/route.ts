import { platformRoute } from '@/server/domains/platform/guard';
import { integrationsStatus } from '@/server/domains/platform/reports';

/** GET /api/v1/platform/integrations — honest provider status, job failures, outbox backlog, provider events. */
export const GET = platformRoute({
  platformCapability: 'platform.integrations.view',
  handler: async () => ({ data: await integrationsStatus() }),
});
