import { clearSessionCookie, route } from '@/server/http/route';
import { logout } from '@/server/auth/service';

/** POST /api/v1/auth/logout */
export const POST = route({
  auth: 'optional',
  handler: async ({ user, responseInit }) => {
    if (user) await logout(user.sessionId);
    responseInit.cookies.push(clearSessionCookie());
    return { data: { signed_out: true } };
  },
});
