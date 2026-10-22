import { route } from '@/server/http/route';
import { applyUnsubscribe } from '@/server/domains/customers/consents';
import { unsubscribeInput } from '@/shared/schemas/customers';

/** POST /api/v1/unsubscribe — signed one-click token; no login. GET never mutates (link scanners). */
export const POST = route({
  auth: 'public', input: unsubscribeInput, rateLimit: { scope: 'ip', name: 'unsubscribe', limit: 30, windowSec: 600 },
  handler: async ({ input, actor }) => ({ data: await applyUnsubscribe(input.token, actor) }),
});
