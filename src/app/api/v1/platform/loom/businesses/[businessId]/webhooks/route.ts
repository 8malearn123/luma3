import { platformRoute } from '@/server/domains/platform/guard';
import { loomBusinesses, loomWebhooks } from '@/loom';

export const GET = platformRoute({
  platformCapability: 'platform.loom.manage',
  handler: async ({ params }) => ({ data: await loomWebhooks.listEndpoints({ businessId: await loomBusinesses.resolveExternal(params.businessId!) }) }),
});

export const POST = platformRoute({
  platformCapability: 'platform.loom.manage', input: loomWebhooks.endpointInput,
  handler: async ({ params, actor, input }) => ({ status: 201, data: await loomWebhooks.createEndpoint({ businessId: await loomBusinesses.resolveExternal(params.businessId!), actor }, input) }),
});
