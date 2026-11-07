import { platformRoute } from '@/server/domains/platform/guard';
import { updatePromotion } from '@/server/domains/platform/pricing';
import { requireUuidParam } from '@/server/http/params';
import { promotionUpdateInput } from '@/shared/schemas/admin';

/** PATCH /api/v1/platform/promotions/:id — edit or disable an offer (versioned, step-up). */
export const PATCH = platformRoute({
  platformCapability: 'platform.plans.manage', stepUp: true, input: promotionUpdateInput,
  handler: async ({ params, input, actor }) => ({ data: await updatePromotion(requireUuidParam(params, 'id'), actor, input) }),
});
