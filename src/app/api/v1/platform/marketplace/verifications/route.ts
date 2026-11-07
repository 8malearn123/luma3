import { platformRoute } from '@/server/domains/platform/guard';
import { listVerifications } from '@/server/domains/marketplace/listing';
import { queueQuery } from '@/shared/schemas/marketplace';

/** GET — verification queue (default: every submitted file). */
export const GET = platformRoute({ platformCapability: 'platform.marketplace.review', input: queueQuery, handler: async ({ input }) => ({ data: { items: await listVerifications(input) } }) });
