import { route } from '@/server/http/route';
import { saveLayout } from '@/server/domains/builder/service';
import { saveLayoutInput } from '@/shared/builder/api';

export const PATCH = route({
  auth: 'tenant', capability: 'builder.edit', input: saveLayoutInput,
  handler: async ({ tenant, actor, input }) => ({ data: await saveLayout(tenant, actor, input) }),
});
