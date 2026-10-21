import { route } from '@/server/http/route';
import { createCoupon, listCoupons } from '@/server/domains/commerce/coupons';
import { couponInput } from '@/shared/schemas/commerce';

export const GET = route({
  auth: 'tenant', capability: 'catalog.edit',
  handler: async ({ tenant }) => ({ data: await listCoupons(tenant) }),
});

export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', input: couponInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createCoupon(tenant, actor, input) }),
});
