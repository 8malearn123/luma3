import { route } from '@/server/http/route';
import { invite } from '@/server/domains/team/service';
import { inviteInput } from '@/shared/schemas/team';

export const POST = route({
  auth: 'tenant', capability: 'team.manage', input: inviteInput,
  rateLimit: { scope: 'user', name: 'invite', limit: 30, windowSec: 3600 },
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await invite(tenant, actor, input) }),
});
