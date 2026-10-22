import { route } from '@/server/http/route';
import { proposePrice } from '@/server/domains/catalog/service';
import { priceProposalInput } from '@/shared/schemas/catalog';
import { requireUuidParam } from '@/server/http/params';

export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', input: priceProposalInput,
  handler: async ({ tenant, actor, input, params }) => ({ status: 201, data: await proposePrice(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
