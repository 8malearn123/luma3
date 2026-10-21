import { route } from '@/server/http/route';
import { requestRecovery } from '@/server/auth/service';
import { recoveryRequestSchema } from '@/server/auth/schemas';

/** POST /api/v1/auth/recovery/request — identical response whether or not the account exists. */
export const POST = route({
  auth: 'public',
  input: recoveryRequestSchema,
  handler: async ({ input, ip }) => ({ status: 202, data: await requestRecovery({ identifier: input.identifier, locale: input.locale, ip }) }),
});
