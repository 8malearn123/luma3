import { route } from '@/server/http/route';
import { createPreviewToken, listPreviewTokens } from '@/server/domains/builder/publish';
import { previewTokenInput } from '@/shared/builder/api';

export const GET = route({
  auth: 'tenant', capability: ['builder.edit', 'builder.publish'],
  handler: async ({ tenant }) => ({ data: await listPreviewTokens(tenant) }),
});

/** POST — temporary draft preview link (max 7 days); the raw token is shown once. */
export const POST = route({
  auth: 'tenant', capability: 'builder.edit', input: previewTokenInput,
  rateLimit: { scope: 'user', name: 'preview_token', limit: 60, windowSec: 3600 },
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createPreviewToken(tenant, actor, input.ttl_hours) }),
});
