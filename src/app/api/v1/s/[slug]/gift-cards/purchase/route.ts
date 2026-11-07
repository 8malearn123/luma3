import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';
import { purchaseGiftCard } from '@/server/domains/giftcards/online';
import { recordAcquisition } from '@/server/domains/customers/acquisition';
import { sessionFromRequest } from '@/server/domains/analytics/events';
import { giftCardPurchaseInput } from '@/shared/schemas/customer-experience';

/** POST /api/v1/s/{slug}/gift-cards/purchase — buy a gift card online and schedule its direct send to the recipient. */
export const POST = route({
  auth: 'user', requireVerified: true, idempotency: 'required', input: giftCardPurchaseInput,
  rateLimit: { scope: 'user', name: 'giftcard_purchase', limit: 20, windowSec: 3600 },
  handler: async ({ req, params, user, input, actor, idempotencyKey }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.gift_cards');
    const r = await purchaseGiftCard(t.id, params.slug!, user, input, { idempotencyKey: idempotencyKey!, actor: { ...actor, kind: 'customer' } });
    const tc = await withTenant(t.id, (trx) => trx.selectFrom('tenant_customers').select('id').where('user_id', '=', user.userId).executeTakeFirst());
    const acq = tc ? await recordAcquisition(t.id, { tenantCustomerId: tc.id }, sessionFromRequest(req)) : null;
    return { status: r.status, data: { ...(r.body as object), acquisition_question: acq?.needs_question ?? false } };
  },
});
