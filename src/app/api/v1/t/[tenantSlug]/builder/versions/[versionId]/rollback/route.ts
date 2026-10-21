import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { rollback } from '@/server/domains/builder/publish';

/** POST — republish an earlier design as a new version (design only; audited). */
export const POST = route({
  auth: 'tenant', capability: 'builder.publish', input: z.object({}).strict(), idempotency: 'required',
  handler: async ({ tenant, actor, params, idempotencyKey }) => {
    const r = await rollback(tenant, actor, requireUuidParam(params, 'versionId'), idempotencyKey!);
    return { status: r.replayed ? 200 : 201, data: r };
  },
});
