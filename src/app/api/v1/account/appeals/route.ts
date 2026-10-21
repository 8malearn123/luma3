import { route } from '@/server/http/route';
import { fileAppeal, listMyAppeals } from '@/server/domains/customers/account';
import { appealCreate } from '@/shared/schemas/policy';

export const GET = route({ auth: 'user', handler: async ({ user }) => ({ data: await listMyAppeals(user) }) });

export const POST = route({
  auth: 'user', input: appealCreate, rateLimit: { scope: 'user', name: 'appeal', limit: 10, windowSec: 3600 },
  handler: async ({ user, actor, input }) => ({ status: 201, data: await fileAppeal(user, actor, input) }),
});
