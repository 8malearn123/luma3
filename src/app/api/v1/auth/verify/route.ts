import { route, sessionCookie } from '@/server/http/route';
import { createSession, verifyContact } from '@/server/auth/service';
import { verifySchema } from '@/server/auth/schemas';

/** POST /api/v1/auth/verify — confirms a contact with its one-time code and signs the user in. */
export const POST = route({
  auth: 'optional',
  input: verifySchema,
  handler: async ({ input, ip, userAgent, user, responseInit }) => {
    const { userId } = await verifyContact({ identifier: input.identifier, code: input.code, ip });
    if (!user || user.userId !== userId) {
      const s = await createSession(userId, ip, userAgent);
      responseInit.cookies.push(sessionCookie(s.token, s.expiresAt));
    }
    return { data: { verified: true } };
  },
});
