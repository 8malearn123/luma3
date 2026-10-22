import { route } from '@/server/http/route';
import { policyAuditTrail } from '@/server/domains/policy/service';
import { auditQuery } from '@/shared/schemas/policy';

export const GET = route({
  auth: 'tenant', capability: ['incidents.review', 'audit.view'], input: auditQuery,
  handler: async ({ tenant, input }) => ({ data: await policyAuditTrail(tenant, input) }),
});
