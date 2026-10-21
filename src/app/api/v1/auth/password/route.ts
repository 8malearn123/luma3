import { route } from '@/server/http/route';
import { changePassword } from '@/server/auth/service';
import { changePasswordSchema } from '@/server/auth/schemas';

/** POST /api/v1/auth/password — change password; other sessions are revoked. */
export const POST = route({
  auth: 'user',
  input: changePasswordSchema,
  rateLimit: { scope: 'user', name: 'password', limit: 10, windowSec: 3600 },
  handler: async ({ input, user, ip }) => {
    await changePassword({ userId: user.userId, sessionId: user.sessionId, currentPassword: input.current_password, newPassword: input.new_password, ip });
    return { data: { changed: true } };
  },
});
