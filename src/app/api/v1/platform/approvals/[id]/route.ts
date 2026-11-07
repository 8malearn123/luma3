import { platformRoute } from '@/server/domains/platform/guard';
import { decideApproval } from '@/server/domains/platform/settings';
import { requireUuidParam } from '@/server/http/params';
import { approvalDecisionInput } from '@/shared/schemas/admin';

/** POST /api/v1/platform/approvals/:tenantId — approve or reject a new business (step-up, audited, owner notified). */
export const POST = platformRoute({
  platformCapability: 'platform.tenants.manage', stepUp: true, input: approvalDecisionInput,
  handler: async ({ params, input, actor }) => ({ data: await decideApproval(requireUuidParam(params, 'id'), actor, input) }),
});
