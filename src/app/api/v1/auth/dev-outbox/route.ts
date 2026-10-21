import { z } from 'zod';
import { route } from '@/server/http/route';
import { devOutbox } from '@/server/auth/service';

/**
 * GET /api/v1/auth/dev-outbox?destination=… — DEVELOPMENT ONLY.
 * Returns 404 unless DEV_OTP_ECHO is enabled outside production.
 */
export const GET = route({
  auth: 'public',
  input: z.object({ destination: z.string().min(3).max(254) }),
  handler: async ({ input }) => ({ data: { simulated: true, messages: await devOutbox(input.destination) } }),
});
