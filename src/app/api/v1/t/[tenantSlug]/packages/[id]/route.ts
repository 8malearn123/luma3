import { route } from '@/server/http/route';
import { archivePackage } from '@/server/domains/catalog/service';
import { requireUuidParam } from '@/server/http/params';

export const DELETE = route({
  auth: 'tenant', capability: 'catalog.edit',
  handler: async ({ tenant, actor, params }) => ({ data: await archivePackage(tenant, actor, requireUuidParam(params, 'id')) }),
});
