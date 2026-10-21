import { route } from '@/server/http/route';
import { createBusiness } from '@/server/domains/tenants/service';
import { createBusinessSchema } from '@/shared/onboarding';

/** POST /api/v1/tenants — create a business; the caller becomes its owner (trusted server transaction). */
export const POST = route({
  auth: 'user',
  requireVerified: true,
  input: createBusinessSchema,
  rateLimit: { scope: 'user', name: 'create_business', limit: 5, windowSec: 3600 },
  handler: async ({ user, input, actor }) => ({ status: 201, data: await createBusiness(user, input, actor) }),
});
