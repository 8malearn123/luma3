import { z } from 'zod';
import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { connectSandbox } from '@/server/domains/payments/service';
import { PROVIDER_CATALOG } from '@/server/domains/payments/providers/registry';

export const GET = route({
  auth: 'tenant', capability: ['payments.configure', 'business.manage', 'finance.view'],
  handler: async ({ tenant }) => ({
    data: {
      accounts: await withTenant(tenant.tenantId, (trx) => trx.selectFrom('payment_accounts').select(['id', 'provider', 'mode', 'status', 'enabled_methods', 'created_at']).orderBy('created_at').execute()),
      catalog: PROVIDER_CATALOG,
    },
  }),
});

/** POST { provider: 'sandbox' } — only integrated providers can be connected. */
export const POST = route({
  auth: 'tenant', capability: ['payments.configure', 'business.manage'], input: z.object({ provider: z.enum(['sandbox', 'moyasar', 'tap', 'tabby', 'tamara']) }), stepUp: true,
  handler: async ({ tenant, input, actor }) => {
    if (input.provider !== 'sandbox') throw Errors.unavailable('provider_not_integrated', 'This provider is not integrated yet');
    return { status: 201, data: await connectSandbox(tenant, actor) };
  },
});
