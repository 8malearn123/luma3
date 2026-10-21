import { platformRoute } from '@/server/domains/platform/guard';
import { setTenantStatus } from '@/server/domains/platform/tenants';
import { requireUuidParam } from '@/server/http/params';
import { tenantStatusInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/tenants/:id/status — suspend / reinstate (step-up, audited, owner notified). */
export const POST = platformRoute({
  platformCapability: 'platform.tenants.manage', stepUp: true, input: tenantStatusInput,
  handler: async ({ params, actor, input }) => ({ data: await setTenantStatus(requireUuidParam(params, 'id'), actor, input) }),
});
