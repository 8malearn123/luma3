import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { updateCoupon } from '@/server/domains/commerce/coupons';
import { couponPatch } from '@/shared/schemas/commerce';

export const PATCH = route({
  auth: 'tenant', capability: 'catalog.edit', input: couponPatch,
  handler: async ({ tenant, actor, input, params }) => ({ data: await updateCoupon(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
