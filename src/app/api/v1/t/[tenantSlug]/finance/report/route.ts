import { z } from 'zod';
import { route } from '@/server/http/route';
import { financeReport } from '@/server/domains/finance/service';

const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const GET = route({
  auth: 'tenant', capability: 'finance.view', feature: 'feature.finance_reports', input: z.object({ from: d, to: d }),
  handler: async ({ tenant, input }) => ({ data: await financeReport(tenant, input.from, input.to) }),
});
