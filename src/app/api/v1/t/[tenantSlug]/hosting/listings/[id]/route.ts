import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getListing, updateListing } from '@/server/domains/hosting/listings';
import { listingUpdateInput } from '@/shared/schemas/hosting';

export const GET = route({ auth: 'tenant', capability: ['hosting.view', 'hosting.manage'], handler: async ({ tenant, params }) => ({ data: await getListing(tenant, requireUuidParam(params, 'id')) }) });
/** Edits bump the terms version; existing bookings keep their frozen terms. */
export const PATCH = route({
  auth: 'tenant', capability: 'hosting.manage', input: listingUpdateInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateListing(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
