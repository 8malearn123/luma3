import { route } from '@/server/http/route';
import { getBuilderState } from '@/server/domains/builder/service';

/** GET — full editor state: drafts + versions, validation, warnings, readiness, AI status, catalog options. */
export const GET = route({
  auth: 'tenant', capability: ['builder.edit', 'builder.publish'],
  handler: async ({ tenant }) => ({ data: await getBuilderState(tenant) }),
});
