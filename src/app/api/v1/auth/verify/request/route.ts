import { z } from 'zod';
import { route } from '@/server/http/route';
import { requestVerification } from '@/server/auth/service';

/** POST /api/v1/auth/verify/request — re-sends a verification code for the signed-in user. */
export const POST = route({
  auth: 'user',
  input: z.object({ kind: z.enum(['email', 'phone']) }),
  handler: async ({ input, user, locale }) => ({ status: 202, data: { delivery: await requestVerification(user.userId, input.kind, locale) } }),
});
