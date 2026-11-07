import { platformRoute } from '@/server/domains/platform/guard';
import { settleStatement } from '@/server/domains/settlements/service';
import { requireUuidParam } from '@/server/http/params';
import { settlementSettleInput } from '@/shared/schemas/admin';

/** POST /api/v1/platform/settlements/:id/settle — record the intermediary's settlement reference (step-up; freezes the statement). */
export const POST = platformRoute({
  platformCapability: 'platform.settlements.manage', stepUp: true, input: settlementSettleInput,
  handler: async ({ params, input, actor }) => ({ data: await settleStatement(requireUuidParam(params, 'id'), actor, input) }),
});
