import { route } from '@/server/http/route';
import { joinWaitlist } from '@/server/domains/waitlist/service';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';
import { waitlistJoinInput } from '@/shared/schemas/waitlist';

/** POST join the waitlist (signed-in, verified). Offers are only sent with notification consent. */
export const POST = route({
  auth: 'user', requireVerified: true, input: waitlistJoinInput,
  rateLimit: { scope: 'user', name: 'waitlist_join', limit: 20, windowSec: 3600 },
  handler: async ({ params, user, input, actor }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.waitlist');
    const r = await joinWaitlist(t.id, user, input, { actor: { ...actor, kind: 'customer' } });
    return { status: 201, data: { id: r.id, status: r.status, expires_at: r.expires_at } };
  },
});
