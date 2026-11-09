import { route } from '@/server/http/route';
import { getHrSettings, hrSettingsInput, updateHrSettings } from '@/server/domains/hr/settings';

/** GET HR settings (grace minutes, balance policy, attendance deductions). */
export const GET = route({
  auth: 'tenant', capability: ['hr.request', 'hr.configure', 'leave.approve', 'payroll.view', 'attendance.manage'],
  handler: async ({ tenant }) => ({ data: await getHrSettings(tenant) }),
});
export const PATCH = route({
  auth: 'tenant', capability: 'hr.configure', input: hrSettingsInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateHrSettings(tenant, actor, input) }),
});
