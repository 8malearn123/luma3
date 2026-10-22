import { route } from '@/server/http/route';
import { commissionRuleInput, createCommissionRule, listCommissionRules } from '@/server/domains/finance/service';

export const GET = route({ auth: 'tenant', capability: ['finance.view', 'staff.edit'], handler: async ({ tenant }) => ({ data: await listCommissionRules(tenant) }) });
export const POST = route({ auth: 'tenant', capability: 'finance.manage', input: commissionRuleInput, handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createCommissionRule(tenant, actor, input) }) });
