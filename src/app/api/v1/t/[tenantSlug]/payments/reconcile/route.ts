import { route } from '@/server/http/route';
import { reconcileTenant } from '@/server/domains/payments/service';

export const POST = route({ auth: 'tenant', capability: 'finance.view', handler: async ({ tenant, actor }) => ({ data: await reconcileTenant(tenant.tenantId, actor.userId) }) });
