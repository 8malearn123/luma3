import { z } from 'zod';
import { route } from '@/server/http/route';
import { acceptInvitation } from '@/server/domains/team/service';

/** POST /api/v1/invitations/accept — join a business with an invitation token. */
export const POST = route({
  auth: 'user',
  input: z.object({ token: z.string().min(20).max(200) }),
  rateLimit: { scope: 'user', name: 'accept_invite', limit: 20, windowSec: 3600 },
  handler: async ({ user, input, actor }) => ({ data: await acceptInvitation(user, input.token, actor) }),
});
