import { platformRoute } from '@/server/domains/platform/guard';
import { listListingRequests } from '@/server/domains/marketplace/listing';
import { queueQuery } from '@/shared/schemas/marketplace';

/** GET — marketplace join requests (default: every non-draft listing). */
export const GET = platformRoute({ platformCapability: 'platform.marketplace.review', input: queueQuery, handler: async ({ input }) => ({ data: { items: await listListingRequests(input) } }) });
