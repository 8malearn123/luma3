import { route } from '@/server/http/route';
import { addTimeBlock } from '@/server/domains/schedule/service';
import { timeBlockInput } from '@/shared/schemas/team';

export const POST = route({
  auth: 'tenant', capability: 'schedule.manage', input: timeBlockInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await addTimeBlock(tenant, actor, input) }),
});
