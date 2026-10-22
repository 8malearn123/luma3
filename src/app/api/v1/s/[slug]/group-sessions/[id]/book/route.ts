import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { bookSeats } from '@/server/domains/groups/service';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';
import { groupBookInput } from '@/shared/schemas/waitlist';

export const POST = route({
  auth: 'user', requireVerified: true, idempotency: 'required', input: groupBookInput,
  handler: async ({ params, user, input, actor, idempotencyKey }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.group_sessions');
    const r = await bookSeats(t.id, user, requireUuidParam(params, 'id'), input.seats, idempotencyKey!, { ...actor, kind: 'customer' });
    return { status: r.status, data: r.body };
  },
});
