import { z } from 'zod';
import { route } from '@/server/http/route';
import { storefrontBookingStatus } from '@/server/domains/onboarding/service';

/** GET [?exclude_service=id] — is the live storefront bookable (now / if that service were archived)? */
export const GET = route({
  auth: 'tenant', capability: ['catalog.edit', 'builder.edit', 'builder.publish'],
  input: z.object({ exclude_service: z.string().uuid().optional() }),
  handler: async ({ tenant, input }) => ({ data: await storefrontBookingStatus(tenant, { excludeServiceId: input.exclude_service }) }),
});
