import { route } from '@/server/http/route';
import { returnToSupplier } from '@/server/domains/commerce/purchasing';
import { supplierReturnInput } from '@/shared/schemas/inventory';

/** Goods returned to the supplier (stock out at weighted average). */
export const POST = route({
  auth: 'tenant', capability: ['purchasing.receive', 'purchasing.manage'], feature: 'feature.purchasing', input: supplierReturnInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await returnToSupplier(tenant, actor, input) }),
});
