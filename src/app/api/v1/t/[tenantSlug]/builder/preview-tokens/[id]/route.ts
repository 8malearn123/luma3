import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { revokePreviewToken } from '@/server/domains/builder/publish';

export const DELETE = route({
  auth: 'tenant', capability: 'builder.edit',
  handler: async ({ tenant, actor, params }) => ({ data: await revokePreviewToken(tenant, actor, requireUuidParam(params, 'id')) }),
});
