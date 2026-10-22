import { route } from '@/server/http/route';
import { issueGiftCard, issueInput, listGiftCards } from '@/server/domains/giftcards/service';

export const GET = route({ auth: 'tenant', capability: 'giftcards.manage', feature: 'feature.gift_cards', handler: async ({ tenant }) => ({ data: await listGiftCards(tenant) }) });
/** POST issue a gift card; the code is returned once and only its hash is stored. */
export const POST = route({
  auth: 'tenant', capability: 'giftcards.manage', feature: 'feature.gift_cards', idempotency: 'required', input: issueInput,
  handler: async ({ tenant, actor, input, idempotencyKey }) => { const r = await issueGiftCard(tenant, actor, input, idempotencyKey!); return { status: r.status, data: r.body }; },
});
