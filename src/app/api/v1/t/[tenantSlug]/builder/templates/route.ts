import { route } from '@/server/http/route';
import { listTemplates } from '@/server/domains/builder/templates';

export const GET = route({
  auth: 'tenant', capability: 'builder.edit',
  handler: async ({ tenant }) => ({ data: await listTemplates(tenant) }),
});
