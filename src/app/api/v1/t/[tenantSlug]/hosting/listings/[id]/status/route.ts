import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { setListingStatus } from '@/server/domains/hosting/listings';
import { listingStatusInput } from '@/shared/schemas/hosting';

/** Publish / pause / archive. Publishing needs the plan feature, the space limit and an active payment account (D3c). */
export const POST = route({
  auth: 'tenant', capability: 'hosting.manage', input: listingStatusInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await setListingStatus(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
