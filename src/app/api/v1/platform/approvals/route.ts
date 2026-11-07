import { platformRoute } from '@/server/domains/platform/guard';
import { listApprovals } from '@/server/domains/platform/settings';
import { approvalListQuery } from '@/shared/schemas/admin';

/** GET /api/v1/platform/approvals — new businesses awaiting manual approval. */
export const GET = platformRoute({
  platformCapability: 'platform.tenants.view', input: approvalListQuery,
  handler: async ({ input }) => ({ data: await listApprovals(input) }),
});
