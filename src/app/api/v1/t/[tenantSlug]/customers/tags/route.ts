import { route } from '@/server/http/route';
import { customerTags } from '@/server/domains/customers/service';

export const GET = route({
  auth: 'tenant', capability: 'customers.view',
  handler: async ({ tenant }) => ({ data: await customerTags(tenant) }),
});
