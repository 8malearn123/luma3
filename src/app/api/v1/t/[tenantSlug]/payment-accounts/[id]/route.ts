import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { disconnectAccount } from '@/server/domains/payments/service';

export const DELETE = route({ auth: 'tenant', capability: ['payments.configure', 'business.manage'], stepUp: true, handler: async ({ tenant, actor, params }) => ({ data: await disconnectAccount(tenant, actor, requireUuidParam(params, 'id')) }) });
