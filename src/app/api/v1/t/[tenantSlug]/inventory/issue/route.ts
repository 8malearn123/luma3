import { route } from '@/server/http/route';
import { issueMaterial } from '@/server/domains/commerce/consumption';
import { issueInput } from '@/shared/schemas/inventory';

/** Manual issue of materials with a documented reason (no booking). */
export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: issueInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await issueMaterial(tenant, actor, input) }),
});
