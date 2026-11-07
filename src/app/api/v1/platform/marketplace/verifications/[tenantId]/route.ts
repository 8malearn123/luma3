import { platformRoute } from '@/server/domains/platform/guard';
import { verificationDetail } from '@/server/domains/marketplace/listing';
import { requireUuidParam } from '@/server/http/params';

/** GET — one business's verification file (documents, IBAN) for a reviewer. */
export const GET = platformRoute({ platformCapability: 'platform.marketplace.review', handler: async ({ params }) => ({ data: await verificationDetail(requireUuidParam(params, 'tenantId')) }) });
