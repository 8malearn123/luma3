import { route } from '@/server/http/route';
import { listPlans } from '@/server/domains/memberships/service';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';

export const GET = route({
  auth: 'public',
  handler: async ({ params }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.memberships');
    return { data: (await listPlans(t.id, true)).map(({ id, name_ar, name_en, description_ar, description_en, price_minor, validity_days, items }) => ({ id, name_ar, name_en, description_ar, description_en, price_minor, validity_days, items })) };
  },
});
