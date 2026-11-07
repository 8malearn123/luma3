import { z } from 'zod';
import { route } from '@/server/http/route';
import { createRequestType, listRequestTypes, requestTypeInput } from '@/server/domains/hr/requests';

/** GET request types (seeded on first use). */
export const GET = route({
  auth: 'tenant', capability: ['hr.request', 'hr.configure', 'leave.approve', 'schedule.manage'],
  input: z.object({ include_inactive: z.enum(['1', '0']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listRequestTypes(tenant, { includeInactive: input.include_inactive === '1' }) }),
});
/** POST a custom request type with its approval chain and fields. */
export const POST = route({
  auth: 'tenant', capability: 'hr.configure', input: requestTypeInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createRequestType(tenant, actor, input) }),
});
