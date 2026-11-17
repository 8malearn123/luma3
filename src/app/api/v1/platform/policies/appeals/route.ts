import { platformRoute } from '@/server/domains/platform/guard';
import { listPlatformAppeals } from '@/server/domains/policy/platform';
import { appealListQuery } from '@/shared/schemas/policy';

export const GET = platformRoute({
  platformCapability: 'platform.policy.review', input: appealListQuery,
  handler: async ({ input }) => ({ data: await listPlatformAppeals(input) }),
});
