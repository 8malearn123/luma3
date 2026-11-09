import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { publicTenant } from '@/server/domains/storefront-public';
import { acceptQuote } from '@/server/domains/events/service';
import { eventAcceptInput } from '@/shared/schemas/events';

/** POST accept the quote: holds the specialist's time and starts the deposit checkout (amount computed server-side). */
export const POST = route({
  auth: 'user', requireVerified: true, idempotency: 'required', input: eventAcceptInput,
  handler: async ({ params, user, input, actor, idempotencyKey }) => {
    const t = await publicTenant(params.slug!);
    const id = requireUuidParam(params, 'id');
    const r = await acceptQuote(t.id, user, id, { quoteVersion: input.quote_version, idempotencyKey: idempotencyKey!, returnUrl: `/s/${t.slug}/events/${id}`, actor: { ...actor, kind: 'customer' } });
    return { status: r.status, data: r.body };
  },
});
