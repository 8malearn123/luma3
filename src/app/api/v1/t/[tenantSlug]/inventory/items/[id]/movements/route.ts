import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { listMovements, recordMovement } from '@/server/domains/commerce/inventory';
import { movementInput } from '@/shared/schemas/commerce';

/** Movement history. Retail items need feature.products; materials need feature.inventory (checked in the service). */
export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage', 'catalog.edit'],
  input: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(300).optional() }),
  handler: async ({ tenant, params, input }) => ({ data: await listMovements(tenant, requireUuidParam(params, 'id'), input) }),
});

/** Receive stock or adjust it (mandatory reason). Capability/feature depend on the item kind (checked in the service). */
export const POST = route({
  auth: 'tenant', capability: ['inventory.manage', 'catalog.edit'], input: movementInput,
  handler: async ({ tenant, actor, input, params }) => ({ status: 201, data: await recordMovement(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
