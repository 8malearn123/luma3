import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { savePageBlocks } from '@/server/domains/builder/service';
import { savePageBlocksInput } from '@/shared/builder/api';

/** PUT {version, blocks} — saves a page draft; stale version -> 409 version_conflict. */
export const PUT = route({
  auth: 'tenant', capability: 'builder.edit', input: savePageBlocksInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await savePageBlocks(tenant, actor, requireUuidParam(params, 'pageId'), input) }),
});
