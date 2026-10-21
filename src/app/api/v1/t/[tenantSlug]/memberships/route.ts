import { z } from 'zod';
import { route } from '@/server/http/route';
import { customerMemberships, sellMembership } from '@/server/domains/memberships/service';

export const GET = route({
  auth: 'tenant', capability: ['memberships.manage', 'bookings.manage', 'customers.view'], feature: 'feature.memberships', input: z.object({ customer_id: z.string().uuid() }),
  handler: async ({ tenant, input }) => ({ data: await customerMemberships(tenant.tenantId, input.customer_id) }),
});
/** POST sell a membership at the counter (collector identity + reference recorded). */
export const POST = route({
  auth: 'tenant', capability: ['memberships.manage'], feature: 'feature.memberships', idempotency: 'required',
  input: z.object({ customer_id: z.string().uuid(), plan_id: z.string().uuid(), method: z.enum(['cash', 'pos_terminal']), reference: z.string().trim().min(2).max(80) }),
  handler: async ({ tenant, actor, input, idempotencyKey }) => {
    const r = await sellMembership(tenant, actor, { tenantCustomerId: input.customer_id, planId: input.plan_id, method: input.method, reference: input.reference, idempotencyKey: idempotencyKey! });
    return { status: r.status, data: r.body };
  },
});
