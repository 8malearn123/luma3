import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { archivePage, updatePage } from '@/server/domains/builder/service';
import { updatePageInput } from '@/shared/builder/api';

export const PATCH = route({
  auth: 'tenant', capability: 'builder.edit', input: updatePageInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await updatePage(tenant, actor, requireUuidParam(params, 'pageId'), input) }),
});

/** DELETE archives (custom pages only); nothing is deleted. */
export const DELETE = route({
  auth: 'tenant', capability: 'builder.edit',
  handler: async ({ tenant, actor, params }) => ({ data: await archivePage(tenant, actor, requireUuidParam(params, 'pageId')) }),
});
