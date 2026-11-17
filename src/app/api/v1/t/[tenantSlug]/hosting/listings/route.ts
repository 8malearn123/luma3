import { route } from '@/server/http/route';
import { createListing, listListings } from '@/server/domains/hosting/listings';
import { listingInput } from '@/shared/schemas/hosting';

/** Spaces offered for rent («المساحات والاستضافة»). Creating counts against limit.hosting_spaces. */
export const GET = route({ auth: 'tenant', capability: ['hosting.view', 'hosting.manage'], handler: async ({ tenant }) => ({ data: await listListings(tenant) }) });
export const POST = route({
  auth: 'tenant', capability: 'hosting.manage', input: listingInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createListing(tenant, actor, input) }),
});
