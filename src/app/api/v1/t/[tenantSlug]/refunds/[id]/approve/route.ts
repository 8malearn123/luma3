import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { approveRefund } from '@/server/domains/payments/service';

export const POST = route({ auth: 'tenant', capability: 'refunds.approve', handler: async ({ tenant, actor, params }) => ({ data: await approveRefund(tenant, actor, requireUuidParam(params, 'id')) }) });
