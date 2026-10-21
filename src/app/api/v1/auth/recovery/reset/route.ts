import { route } from '@/server/http/route';
import { resetPassword } from '@/server/auth/service';
import { recoveryResetSchema } from '@/server/auth/schemas';

/** POST /api/v1/auth/recovery/reset — sets a new password and revokes every session. */
export const POST = route({
  auth: 'public',
  input: recoveryResetSchema,
  handler: async ({ input, ip }) => {
    await resetPassword({ identifier: input.identifier, code: input.code, newPassword: input.new_password, ip });
    return { data: { reset: true } };
  },
});
