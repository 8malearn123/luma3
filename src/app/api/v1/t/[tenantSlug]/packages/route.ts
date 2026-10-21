import { route } from '@/server/http/route';
import { createPackage, listPackages } from '@/server/domains/catalog/service';
import { packageInput } from '@/shared/schemas/catalog';

export const GET = route({ auth: 'tenant', capability: ['catalog.edit', 'bookings.manage'], handler: async ({ tenant }) => ({ data: await listPackages(tenant) }) });
export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', input: packageInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createPackage(tenant, actor, input) }),
});
