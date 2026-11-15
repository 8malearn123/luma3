import { z } from 'zod';
import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { listForHost } from '@/server/domains/hosting/bookings';
import { WS_STATUSES } from '@/shared/schemas/hosting';

/** Space bookings at this salon (the space booking only; never the expert's clients, D14). */
export const GET = route({
  auth: 'tenant', capability: ['hosting.view', 'hosting.manage'], input: z.object({ status: z.string().max(300).optional() }),
  handler: async ({ tenant, input }) => {
    const status = input.status?.split(',').filter((s) => (WS_STATUSES as readonly string[]).includes(s));
    return { data: await withTenant(tenant.tenantId, (trx) => listForHost(trx, tenant.tenantId, status)) };
  },
});
