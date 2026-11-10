import { route } from '@/server/http/route';
import { createSupplier, listSuppliers } from '@/server/domains/commerce/purchasing';
import { supplierInput } from '@/shared/schemas/inventory';

export const GET = route({
  auth: 'tenant', capability: ['purchasing.view', 'purchasing.manage', 'inventory.manage'], feature: 'feature.inventory',
  handler: async ({ tenant }) => ({ data: await listSuppliers(tenant) }),
});

export const POST = route({
  auth: 'tenant', capability: ['purchasing.manage', 'inventory.manage'], feature: 'feature.inventory', input: supplierInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createSupplier(tenant, actor, input) }),
});
