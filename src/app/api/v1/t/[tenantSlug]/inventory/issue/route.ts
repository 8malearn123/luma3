import { route } from '@/server/http/route';
import { issueMaterial } from '@/server/domains/commerce/consumption';
import { issueInput } from '@/shared/schemas/inventory';

/**
 * Manual issue of materials with a documented reason (no booking). The
 * Idempotency-Key is required: one key per user operation (see issueMaterial).
 */
export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: issueInput, idempotency: 'required',
  handler: async ({ tenant, actor, input, idempotencyKey }) => ({ status: 201, data: await issueMaterial(tenant, actor, input, idempotencyKey!) }),
});
