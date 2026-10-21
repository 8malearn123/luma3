import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { decideReturn } from '@/server/domains/commerce/orders';
import { returnDecisionInput } from '@/shared/schemas/commerce';

/** Approve (restocks with a 'return' movement when requested) or reject. */
export const PATCH = route({
  auth: 'tenant', capability: 'orders.manage', feature: 'feature.products', input: returnDecisionInput,
  handler: async ({ tenant, actor, input, params }) => ({
    data: await decideReturn(tenant, actor, requireUuidParam(params, 'id'), requireUuidParam(params, 'returnId'), input.decision),
  }),
});
