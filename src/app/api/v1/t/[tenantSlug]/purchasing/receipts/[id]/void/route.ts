import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { voidDraftReceipt } from '@/server/domains/commerce/purchasing';

export const POST = route({
  auth: 'tenant', capability: 'purchasing.receive', feature: 'feature.purchasing',
  handler: async ({ tenant, actor, params }) => ({ data: await voidDraftReceipt(tenant, actor, requireUuidParam(params, 'id')) }),
});
