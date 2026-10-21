import { route } from '@/server/http/route';
import { createCustomer, listCustomers } from '@/server/domains/customers/service';
import { customerCreate, customerListQuery } from '@/shared/schemas/customers';

/** GET /t/:slug/customers — this business's customers only (search/filter/sort/paginate). */
export const GET = route({
  auth: 'tenant', capability: 'customers.view', input: customerListQuery,
  handler: async ({ tenant, input }) => ({ data: await listCustomers(tenant, input) }),
});

/** POST /t/:slug/customers — walk-in/dashboard customer. Never looks up LUMA accounts. */
export const POST = route({
  auth: 'tenant', capability: 'customers.manage', input: customerCreate, idempotency: 'optional',
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createCustomer(tenant, actor, input) }),
});
