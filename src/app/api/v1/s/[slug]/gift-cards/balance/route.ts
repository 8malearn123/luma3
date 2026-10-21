import { z } from 'zod';
import { route } from '@/server/http/route';
import { checkBalance } from '@/server/domains/giftcards/service';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';

export const POST = route({
  auth: 'optional', input: z.object({ code: z.string().min(8).max(40) }),
  handler: async ({ params, input, ip, user }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.gift_cards');
    return { data: await checkBalance(t.id, input.code, user ? `u:${user.userId}` : `ip:${ip}`) };
  },
});
