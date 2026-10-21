import { route } from '@/server/http/route';
import { register } from '@/server/auth/service';
import { registerSchema } from '@/server/auth/schemas';

/** POST /api/v1/auth/register — creates an unverified account and sends a verification code. */
export const POST = route({
  auth: 'public',
  input: registerSchema,
  handler: async ({ input, ip }) => {
    const r = await register({ identifier: input.identifier, password: input.password, displayName: input.display_name, locale: input.locale, ip });
    return { status: 202, data: { delivery: r.delivery, identifier_kind: r.kind } };
  },
});
