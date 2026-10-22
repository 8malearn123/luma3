import { z } from 'zod';
import { route } from '@/server/http/route';
import { joinWaitlist, listWaitlist } from '@/server/domains/waitlist/service';
import { waitlistJoinInput } from '@/shared/schemas/waitlist';

export const GET = route({
  auth: 'tenant', capability: 'waitlist.manage', feature: 'feature.waitlist',
  input: z.object({ status: z.enum(['active', 'offered', 'fulfilled', 'expired', 'cancelled']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listWaitlist(tenant, input.status) }),
});

/** POST add a customer of this business to the waitlist (consent must be recorded truthfully). */
export const POST = route({
  auth: 'tenant', capability: 'waitlist.manage', feature: 'feature.waitlist', input: waitlistJoinInput.extend({ customer_id: z.string().uuid() }),
  handler: async ({ tenant, input, actor }) => {
    const { customer_id, ...rest } = input;
    return { status: 201, data: await joinWaitlist(tenant.tenantId, null, rest, { tenantCustomerId: customer_id, actor, access: tenant }) };
  },
});
