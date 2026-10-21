import { route } from '@/server/http/route';
import { updateDisplay } from '@/server/domains/settings/service';
import { displayInput } from '@/shared/schemas/settings';

/** PUT /api/v1/t/:slug/settings/display — 12h/24h display (stored instants never change). */
export const PUT = route({
  auth: 'tenant', capability: 'business.manage', input: displayInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateDisplay(tenant, actor, input) }),
});
