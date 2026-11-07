import { route } from '@/server/http/route';
import { acquisitionReport } from '@/server/domains/customers/acquisition';
import { resolvePeriod } from '@/server/domains/analytics/period';
import { acquisitionReportQuery } from '@/shared/schemas/customer-experience';

/** GET new customers by acquisition source («كيف عرفتِ عنا؟») over a period. */
export const GET = route({
  auth: 'tenant', capability: ['analytics.view', 'customers.view'], input: acquisitionReportQuery,
  handler: async ({ tenant, input }) => {
    const p = resolvePeriod(tenant.timezone, input.from, input.to, 30);
    return { data: { ...(await acquisitionReport(tenant, { from: p.start, to: p.end })), period: { from: p.from, to: p.to } } };
  },
});
