import { route } from '@/server/http/route';
import { listSessions, revokeAllSessions } from '@/server/auth/service';

/** GET /api/v1/auth/sessions — active sessions of the current user. */
export const GET = route({
  auth: 'user',
  handler: async ({ user }) => {
    const rows = await listSessions(user.userId);
    return { data: rows.map((r) => ({ ...r, current: r.id === user.sessionId })) };
  },
});

/** DELETE /api/v1/auth/sessions — sign out every other device. */
export const DELETE = route({
  auth: 'user',
  handler: async ({ user }) => {
    await revokeAllSessions(user.userId, 'user_revoked_all', user.sessionId);
    return { data: { revoked: true } };
  },
});
