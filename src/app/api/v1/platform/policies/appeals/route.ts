import { route } from '@/server/http/route';
import { listPlatformAppeals } from '@/server/domains/policy/platform';
import { appealListQuery } from '@/shared/schemas/policy';

export const GET = route({
  auth: 'platform', platformCapability: 'platform.policy.review', input: appealListQuery,
  handler: async ({ input }) => ({ data: await listPlatformAppeals(input) }),
});
