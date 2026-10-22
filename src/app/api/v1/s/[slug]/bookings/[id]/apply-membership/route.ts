import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { applyToBooking } from '@/server/domains/memberships/service';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';

export const POST = route({
  auth: 'user',
  handler: async ({ params, user }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.memberships');
    return { data: await applyToBooking(t.id, requireUuidParam(params, 'id'), user.userId) };
  },
});
