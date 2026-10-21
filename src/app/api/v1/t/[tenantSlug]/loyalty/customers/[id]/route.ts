import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { requireUuidParam } from '@/server/http/params';
import { customerLoyalty } from '@/server/domains/loyalty/service';

/** GET one customer's points balance, tier and recent ledger at this business. */
export const GET = route({
  auth: 'tenant', capability: 'loyalty.manage', feature: 'feature.loyalty',
  handler: async ({ tenant, params }) => {
    const id = requireUuidParam(params, 'id');
    const c = await withTenant(tenant.tenantId, (trx) => trx.selectFrom('tenant_customers').select(['id', 'display_name', 'phone']).where('id', '=', id).executeTakeFirst());
    if (!c) throw Errors.notFound('customer');
    return { data: { customer: c, ...(await customerLoyalty(tenant.tenantId, id)) } };
  },
});
