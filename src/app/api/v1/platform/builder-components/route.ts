import { platformRoute } from '@/server/domains/platform/guard';
import { listComponents } from '@/server/domains/platform/templates';

/** GET /api/v1/platform/builder-components */
export const GET = platformRoute({
  platformCapability: 'platform.templates.manage',
  handler: async () => ({ data: await listComponents() }),
});
