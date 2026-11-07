import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getSlip } from '@/server/domains/payroll/service';
import { payslipHtml } from '@/server/domains/payroll/documents';

/** GET a printable payslip. Payroll managers see any; staff see only their own. */
export const GET = route({
  auth: 'tenant', capability: ['payroll.view', 'payroll.view_own'],
  handler: async ({ tenant, params, locale }) => {
    const slip = await getSlip(tenant, requireUuidParam(params, 'id'));
    return new Response(payslipHtml(slip, locale), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  },
});
