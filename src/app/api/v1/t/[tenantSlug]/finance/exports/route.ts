import { z } from 'zod';
import { route } from '@/server/http/route';
import { createExport } from '@/server/domains/finance/service';

const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** POST create a CSV export; the file is private and downloadable only with finance.export. */
export const POST = route({
  auth: 'tenant', capability: 'finance.export', stepUp: true, input: z.object({ kind: z.enum(['bookings', 'payments', 'journal', 'expenses']), from: d, to: d }),
  rateLimit: { scope: 'user', name: 'finance_export', limit: 20, windowSec: 3600 },
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createExport(tenant, actor, input.kind, input.from, input.to) }),
});
