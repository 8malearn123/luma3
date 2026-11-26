import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { voidDraftInvoice } from '@/server/domains/commerce/purchasing';
import { voidInput } from '@/shared/schemas/inventory';

export const POST = route({
  auth: 'tenant', capability: 'purchasing.manage', feature: 'feature.purchasing', input: voidInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await voidDraftInvoice(tenant, actor, requireUuidParam(params, 'id'), input.reason) }),
});
