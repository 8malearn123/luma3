import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { approveSettlement } from '@/server/domains/hosting/bookings';

/** Approves the settlement statement (immutable; corrections are separate records). */
export const POST = route({
  auth: 'tenant', capability: 'hosting.manage',
  handler: async ({ tenant, actor, params }) => ({ data: await approveSettlement(tenant, actor, requireUuidParam(params, 'id')) }),
});
