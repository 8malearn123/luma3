import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getInvoice } from '@/server/domains/finance/service';

export const GET = route({ auth: 'tenant', capability: ['finance.view', 'payments.collect'], handler: async ({ tenant, params }) => ({ data: await getInvoice(tenant.tenantId, requireUuidParam(params, 'id')) }) });
