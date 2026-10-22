import { z } from 'zod';
import { platformRoute } from '@/server/domains/platform/guard';
import { listInvoices } from '@/server/domains/platform/reports';

/** GET /api/v1/platform/invoices — LUMA subscription invoices (all test). */
export const GET = platformRoute({
  platformCapability: 'platform.revenue.view',
  input: z.object({ status: z.enum(['draft', 'open', 'paid', 'void', 'uncollectible']).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }),
  handler: async ({ input }) => ({ data: await listInvoices(input) }),
});
