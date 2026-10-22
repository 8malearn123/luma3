import { route } from '@/server/http/route';
import { publish } from '@/server/domains/builder/publish';
import { publishInput } from '@/shared/builder/api';

/** POST — publish the draft (readiness + validation; immutable snapshot). Idempotency-Key required. */
export const POST = route({
  auth: 'tenant', capability: 'builder.publish', input: publishInput, idempotency: 'required',
  rateLimit: { scope: 'user', name: 'builder_publish', limit: 60, windowSec: 3600 },
  handler: async ({ tenant, actor, input, idempotencyKey }) => {
    const r = await publish(tenant, actor, idempotencyKey!, input);
    return { status: r.replayed ? 200 : 201, data: r };
  },
});
