import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { addPlanVersion } from '@/server/domains/marketing/plans';
import { planVersionInput } from '@/shared/schemas/marketing';


/** Edits always create a new version; an approved version is never modified. */
export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai', input: planVersionInput,
  handler: async ({ tenant, actor, params, input }) => ({ status: 201, data: await addPlanVersion(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
