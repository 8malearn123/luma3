import { route } from '@/server/http/route';
import { saveBrand } from '@/server/domains/builder/service';
import { saveBrandInput } from '@/shared/builder/api';

export const PATCH = route({
  auth: 'tenant', capability: 'builder.edit', input: saveBrandInput,
  handler: async ({ tenant, actor, input }) => ({ data: await saveBrand(tenant, actor, input) }),
});
