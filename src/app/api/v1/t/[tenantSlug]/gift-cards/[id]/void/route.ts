import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { voidGiftCard } from '@/server/domains/giftcards/service';

export const POST = route({
  auth: 'tenant', capability: 'giftcards.manage', stepUp: true, input: z.object({ reason: z.string().trim().min(3).max(200) }),
  handler: async ({ tenant, actor, params, input }) => ({ data: await voidGiftCard(tenant, actor, requireUuidParam(params, 'id'), input.reason) }),
});
