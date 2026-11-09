import { platformRoute } from '@/server/domains/platform/guard';
import { loomBusinesses, loomConnections } from '@/loom';

export const GET = platformRoute({
  platformCapability: 'platform.loom.manage',
  handler: async ({ params, locale }) => ({ data: await loomConnections.get({ businessId: await loomBusinesses.resolveExternal(params.businessId!), locale }, params.id!) }),
});

export const PATCH = platformRoute({
  platformCapability: 'platform.loom.manage', input: loomConnections.updateConnectionInput,
  handler: async ({ params, actor, locale, input }) => ({ data: await loomConnections.update({ businessId: await loomBusinesses.resolveExternal(params.businessId!), actor, locale }, params.id!, input) }),
});

/** POST { action: test | sync | pause | resume } */
export const POST = platformRoute({
  platformCapability: 'platform.loom.manage', input: loomConnections.connectionActionInput,
  handler: async ({ params, actor, locale, input }) => ({ data: await loomConnections.action({ businessId: await loomBusinesses.resolveExternal(params.businessId!), actor, locale }, params.id!, input.action) }),
});
