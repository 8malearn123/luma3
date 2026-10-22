import { platformRoute } from '@/server/domains/platform/guard';
import { updatePlan } from '@/server/domains/platform/plans';
import { requireUuidParam } from '@/server/http/params';
import { planUpdateInput } from '@/shared/schemas/platform';

/** PUT /api/v1/platform/plans/:id — edit plan fields and feature matrix (platform owner + step-up, versioned). */
export const PUT = platformRoute({
  platformCapability: 'platform.plans.manage', stepUp: true, input: planUpdateInput,
  handler: async ({ params, actor, input }) => ({ data: await updatePlan(requireUuidParam(params, 'id'), actor, input) }),
});
