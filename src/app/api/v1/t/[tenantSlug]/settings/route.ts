import { route } from '@/server/http/route';
import { getSettings } from '@/server/domains/settings/service';

/** GET /api/v1/t/:slug/settings — business profile, policies, legal/tax, channels (owner). */
export const GET = route({
  auth: 'tenant', capability: 'business.manage',
  handler: async ({ tenant }) => ({ data: await getSettings(tenant) }),
});
