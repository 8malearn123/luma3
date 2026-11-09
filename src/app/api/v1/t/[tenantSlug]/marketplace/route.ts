import { route } from '@/server/http/route';
import { marketplaceStatus, updateListing } from '@/server/domains/marketplace/listing';
import { listingPatchInput } from '@/shared/schemas/marketplace';

/** GET — marketplace listing + verification status for this business (owner). */
export const GET = route({ auth: 'tenant', capability: 'business.manage', handler: async ({ tenant }) => ({ data: await marketplaceStatus(tenant) }) });

/** PATCH — hide/show the business and edit its marketplace card (tagline, cover). */
export const PATCH = route({
  auth: 'tenant', capability: 'business.manage', input: listingPatchInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateListing(tenant, actor, input) }),
});
