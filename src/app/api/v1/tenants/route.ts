import { route } from '@/server/http/route';
import { createBusiness } from '@/server/domains/tenants/service';
import { createBusinessSchema } from '@/shared/onboarding';
import { REFERRAL_COOKIE } from '@/server/domains/referrals/service';

/** POST /api/v1/tenants — create a business; the caller becomes its owner (trusted server transaction). */
export const POST = route({
  auth: 'user',
  requireVerified: true,
  input: createBusinessSchema,
  rateLimit: { scope: 'user', name: 'create_business', limit: 5, windowSec: 3600 },
  handler: async ({ req, user, input, actor }) => ({ status: 201, data: await createBusiness(user, input, actor, { referralCookie: req.cookies.get(REFERRAL_COOKIE)?.value }) }),
});
