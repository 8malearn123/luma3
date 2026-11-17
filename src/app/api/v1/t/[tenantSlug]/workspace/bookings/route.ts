import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { listForGuest, requestSpace } from '@/server/domains/hosting/bookings';
import { requestInput } from '@/shared/schemas/hosting';

export const GET = route({ auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book', handler: async ({ tenant }) => ({ data: await withTenant(tenant.tenantId, (trx) => listForGuest(trx, tenant.tenantId)) }) });
/** Request a space: instant listings are held for payment; approval listings wait up to 2 hours for the salon. */
export const POST = route({
  auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book', idempotency: 'required', input: requestInput,
  handler: async ({ tenant, user, actor, input, idempotencyKey }) => {
    const r = await requestSpace(tenant, user, actor, input, idempotencyKey!);
    return { status: r.status, data: r.body };
  },
});
