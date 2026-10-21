import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { dismissEscalation } from '@/server/domains/policy/platform';
import { escalationDismiss } from '@/shared/schemas/policy';

export const POST = route({
  auth: 'platform', platformCapability: 'platform.policy.review', stepUp: true, input: escalationDismiss,
  handler: async ({ user, actor, params, input }) => ({ data: await dismissEscalation(user, actor, requireUuidParam(params, 'id'), input) }),
});
