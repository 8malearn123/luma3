import { route } from '@/server/http/route';
import { listProposals, propose } from '@/server/domains/builder/assistant';
import { proposalInput } from '@/shared/builder/api';

export const GET = route({
  auth: 'tenant', capability: 'builder.edit',
  handler: async ({ tenant }) => ({ data: await listProposals(tenant) }),
});

/** POST {request_text} — natural-language request -> validated, draft-only proposal with a diff. */
export const POST = route({
  auth: 'tenant', capability: 'builder.edit', feature: 'feature.customization_ai', input: proposalInput,
  rateLimit: { scope: 'user', name: 'builder_assistant', limit: 30, windowSec: 3600 },
  handler: async ({ tenant, actor, input, locale }) => ({ status: 201, data: await propose(tenant, actor, input, locale) }),
});
