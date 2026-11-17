import { z } from 'zod';
import { platformRoute } from '@/server/domains/platform/guard';
import { listEscalations } from '@/server/domains/policy/platform';

export const GET = platformRoute({
  platformCapability: 'platform.policy.review',
  input: z.object({ status: z.enum(['pending', 'decided', 'dismissed', 'all']).default('pending'), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }),
  handler: async ({ input }) => ({ data: await listEscalations(input.status, input.cursor, input.limit) }),
});
