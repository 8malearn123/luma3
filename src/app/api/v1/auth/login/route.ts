import { route, sessionCookie } from '@/server/http/route';
import { login } from '@/server/auth/service';
import { loginSchema } from '@/server/auth/schemas';

/** POST /api/v1/auth/login */
export const POST = route({
  auth: 'public',
  input: loginSchema,
  handler: async ({ input, ip, userAgent, responseInit }) => {
    const s = await login({ identifier: input.identifier, password: input.password, ip, userAgent, remember: input.remember });
    responseInit.cookies.push(sessionCookie(s.token, s.cookieExpires));
    return { data: { user_id: s.userId, expires_at: s.expiresAt, remember: s.persistent } };
  },
});
