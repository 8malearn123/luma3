import { platformRoute } from '@/server/domains/platform/guard';
import { loomBusinesses, loomConnections } from '@/loom';

export const GET = platformRoute({
  platformCapability: 'platform.loom.manage',
  handler: async ({ params }) => ({ data: await loomConnections.list({ businessId: await loomBusinesses.resolveExternal(params.businessId!) }) }),
});

export const POST = platformRoute({
  platformCapability: 'platform.loom.manage', input: loomConnections.createConnectionInput,
  handler: async ({ params, actor, locale, input }) => ({ status: 201, data: await loomConnections.create({ businessId: await loomBusinesses.resolveExternal(params.businessId!), actor, locale }, input) }),
});
