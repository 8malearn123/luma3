import { route, zUuid } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { getDigest } from '@/server/domains/business/digest';

/** One digest; money figures are stripped without financial access. */
export const GET = route({
  auth: 'tenant', capability: ['business.manage', 'analytics.view'],
  handler: async ({ tenant, params }) => {
    if (!zUuid.safeParse(params.id).success) throw Errors.notFound('digest');
    return { data: await getDigest(tenant, params.id!) };
  },
});
