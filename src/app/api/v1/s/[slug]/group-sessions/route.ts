import { route } from '@/server/http/route';
import { listSessions } from '@/server/domains/groups/service';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';

export const GET = route({
  auth: 'public',
  handler: async ({ params }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.group_sessions');
    const rows = await listSessions(t.id, { from: new Date(), to: new Date(Date.now() + 60 * 86_400_000), publicOnly: true });
    return { data: rows.map((r) => ({ ...r, seats_left: r.capacity - r.seats_taken, seats_taken: undefined })) };
  },
});
