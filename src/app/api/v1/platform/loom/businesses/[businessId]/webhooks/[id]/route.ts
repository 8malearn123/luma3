import { platformRoute } from '@/server/domains/platform/guard';
import { loomBusinesses, loomWebhooks } from '@/loom';

export const DELETE = platformRoute({
  platformCapability: 'platform.loom.manage',
  handler: async ({ params, actor }) => ({ data: await loomWebhooks.deactivateEndpoint({ businessId: await loomBusinesses.resolveExternal(params.businessId!), actor }, params.id!) }),
});
