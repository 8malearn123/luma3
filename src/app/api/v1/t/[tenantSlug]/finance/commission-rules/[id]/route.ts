import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { deactivateCommissionRule } from '@/server/domains/finance/service';

export const DELETE = route({ auth: 'tenant', capability: 'finance.manage', handler: async ({ tenant, actor, params }) => ({ data: await deactivateCommissionRule(tenant, actor, requireUuidParam(params, 'id')) }) });
