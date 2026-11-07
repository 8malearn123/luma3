import { platformRoute } from '@/server/domains/platform/guard';
import { tenantMarketplaceSummary } from '@/server/domains/marketplace/listing';
import { requireUuidParam } from '@/server/http/params';

/** GET — marketplace summary for the platform business drawer. */
export const GET = platformRoute({ platformCapability: 'platform.tenants.view', handler: async ({ params }) => ({ data: await tenantMarketplaceSummary(requireUuidParam(params, 'tenantId')) }) });
