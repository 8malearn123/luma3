import { route } from '@/server/http/route';
import { createPlan, listPlans, planInput } from '@/server/domains/memberships/service';

export const GET = route({ auth: 'tenant', capability: ['memberships.manage', 'bookings.manage'], feature: 'feature.memberships', handler: async ({ tenant }) => ({ data: await listPlans(tenant.tenantId) }) });
export const POST = route({ auth: 'tenant', capability: 'memberships.manage', feature: 'feature.memberships', input: planInput, handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createPlan(tenant, actor, input) }) });
