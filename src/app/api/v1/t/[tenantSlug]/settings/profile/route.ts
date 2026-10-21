import { route } from '@/server/http/route';
import { updateProfile } from '@/server/domains/settings/service';
import { profileInput } from '@/shared/schemas/settings';

/** PUT /api/v1/t/:slug/settings/profile — versioned (409 on stale version). */
export const PUT = route({
  auth: 'tenant', capability: 'business.manage', input: profileInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateProfile(tenant, actor, input) }),
});
