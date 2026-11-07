import { platformRoute } from '@/server/domains/platform/guard';
import { platformMarketplaceFees } from '@/server/domains/marketplace/attribution';
import { feePeriodQuery } from '@/shared/schemas/marketplace';

/** GET ?from&to — LUMA marketplace commission per business (ledger totals). */
export const GET = platformRoute({ platformCapability: 'platform.marketplace.review', input: feePeriodQuery, handler: async ({ input }) => ({ data: await platformMarketplaceFees(input) }) });
