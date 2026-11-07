import { route } from '@/server/http/route';
import { attendanceReport, attendanceReportInput } from '@/server/domains/hr/deductions';

/** GET late/absent flags per day (scheduled start vs first clock-in). Staff see only their own. */
export const GET = route({
  auth: 'tenant', capability: ['attendance.manage', 'attendance.own'], input: attendanceReportInput,
  handler: async ({ tenant, input }) => ({ data: await attendanceReport(tenant, input) }),
});
