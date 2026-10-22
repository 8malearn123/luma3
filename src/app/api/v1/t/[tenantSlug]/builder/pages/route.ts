import { route } from '@/server/http/route';
import { createPage } from '@/server/domains/builder/service';
import { createPageInput } from '@/shared/builder/api';

/** POST — create a custom page (plan limit `limit.custom_pages`, enforced server-side). */
export const POST = route({
  auth: 'tenant', capability: 'builder.edit', input: createPageInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createPage(tenant, actor, input) }),
});
