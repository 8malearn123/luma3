import { platformRoute } from '@/server/domains/platform/guard';
import { createSupportGrant, listSupportGrants } from '@/server/domains/platform/support';
import { supportGrantInput, supportListQuery } from '@/shared/schemas/platform';

/** GET/POST /api/v1/platform/support-grants — time-limited (≤24h), reasoned support access (step-up to create). */
export const GET = platformRoute({
  platformCapability: 'platform.support.access', input: supportListQuery,
  handler: async ({ user, input }) => ({ data: await listSupportGrants(user, input) }),
});
export const POST = platformRoute({
  platformCapability: 'platform.support.access', stepUp: true, input: supportGrantInput,
  handler: async ({ user, actor, input }) => ({ status: 201, data: await createSupportGrant(user, actor, input) }),
});
