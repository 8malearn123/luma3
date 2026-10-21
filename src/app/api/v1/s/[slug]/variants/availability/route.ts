import { z } from 'zod';
import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { publicVariantAvailability } from '@/server/domains/commerce/products';
import { resolveShop } from '@/server/domains/commerce/cart-cookie';

/** Public: live price & purchasability for product pages (?ids=uuid,uuid). Never exposes costs. */
export const GET = route({
  auth: 'public',
  input: z.object({ ids: z.string().max(2000).transform((s) => s.split(',').filter(Boolean)).pipe(z.array(z.string().uuid()).min(1).max(50)) }),
  handler: async ({ params, input }) => {
    const shop = await resolveShop(params.slug!);
    return { data: await withTenant(shop.tenantId, (trx) => publicVariantAvailability(trx, shop.tenantId, input.ids)) };
  },
});
