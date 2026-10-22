import { route } from '@/server/http/route';
import { reconcileTenant } from '@/server/domains/payments/service';

export const POST = route({ auth: 'tenant', capability: ['finance.manage', 'payments.configure'], handler: async ({ tenant, actor }) => ({ data: await reconcileTenant(tenant.tenantId, actor.userId) }) });
