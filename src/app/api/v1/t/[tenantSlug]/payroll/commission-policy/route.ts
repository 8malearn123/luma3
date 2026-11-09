import { route } from '@/server/http/route';
import { commissionPolicyInput, getCommissionPolicy, updateCommissionPolicy } from '@/server/domains/payroll/service';

/** GET the service-commission policy: business switch, tips switch, default rate and each service's switch and rate. */
export const GET = route({ auth: 'tenant', capability: ['payroll.view', 'finance.view'], handler: async ({ tenant }) => ({ data: await getCommissionPolicy(tenant) }) });

/** PATCH the business switches and the default rate. */
export const PATCH = route({
  auth: 'tenant', capability: 'payroll.manage', input: commissionPolicyInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateCommissionPolicy(tenant, actor, input) }),
});
