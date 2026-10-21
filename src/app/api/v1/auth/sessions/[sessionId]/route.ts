import { route, zUuid } from '@/server/http/route';
import { revokeSession } from '@/server/auth/service';
import { Errors } from '@/server/http/errors';

/** DELETE /api/v1/auth/sessions/:sessionId */
export const DELETE = route({
  auth: 'user',
  handler: async ({ user, params, actor }) => {
    if (!zUuid.safeParse(params.sessionId).success) throw Errors.notFound('session');
    await revokeSession(user.userId, params.sessionId!, actor);
    return { data: { revoked: true } };
  },
});
