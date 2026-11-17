import { route } from '@/server/http/route';
import { listingOptions } from '@/server/domains/hosting/listings';

/** Choices for the listing editor: chairs/rooms, store products for add-ons, payment readiness. */
export const GET = route({ auth: 'tenant', capability: ['hosting.view', 'hosting.manage'], handler: async ({ tenant }) => ({ data: await listingOptions(tenant) }) });
