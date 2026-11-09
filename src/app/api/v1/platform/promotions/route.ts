import { platformRoute } from '@/server/domains/platform/guard';
import { createPromotion, listPromotions } from '@/server/domains/platform/pricing';
import { promotionCreateInput } from '@/shared/schemas/admin';

/** GET /api/v1/platform/promotions */
export const GET = platformRoute({
  platformCapability: 'platform.tenants.view',
  handler: async () => ({ data: await listPromotions() }),
});

/** POST /api/v1/platform/promotions — time-limited % offer, by code or automatic (step-up). */
export const POST = platformRoute({
  platformCapability: 'platform.plans.manage', stepUp: true, input: promotionCreateInput,
  handler: async ({ input, actor }) => ({ status: 201, data: await createPromotion(actor, input) }),
});
