import { route } from '@/server/http/route';
import { listVersions } from '@/server/domains/builder/publish';

export const GET = route({
  auth: 'tenant', capability: ['builder.edit', 'builder.publish'],
  handler: async ({ tenant }) => ({ data: await listVersions(tenant) }),
});
