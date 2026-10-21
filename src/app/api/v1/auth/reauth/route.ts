import { route } from '@/server/http/route';
import { reauthenticate, STEP_UP_WINDOW_MIN } from '@/server/auth/service';
import { reauthSchema } from '@/server/auth/schemas';

/** POST /api/v1/auth/reauth — step-up confirmation for sensitive actions. */
export const POST = route({
  auth: 'user',
  input: reauthSchema,
  handler: async ({ input, user, ip }) => {
    await reauthenticate({ userId: user.userId, sessionId: user.sessionId, password: input.password, ip });
    return { data: { valid_for_minutes: STEP_UP_WINDOW_MIN } };
  },
});
