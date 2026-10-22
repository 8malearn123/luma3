import { platformRoute } from '@/server/domains/platform/guard';
import { platformSubscriptionAction } from '@/server/domains/subscriptions/service';
import { requireUuidParam } from '@/server/http/params';
import { subscriptionActionInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/subscriptions/:id/actions — status changes, trial/grace extension, pause/resume, cancel (step-up). */
export const POST = platformRoute({
  platformCapability: 'platform.subscriptions.manage', stepUp: true, input: subscriptionActionInput,
  handler: async ({ params, actor, input }) => ({ data: await platformSubscriptionAction(requireUuidParam(params, 'id'), actor, input) }),
});
