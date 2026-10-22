import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { applyTemplate } from '@/server/domains/builder/templates';
import { applyTemplateInput } from '@/shared/builder/api';

/** POST — apply an approved template to the draft (structure + shape tokens only). */
export const POST = route({
  auth: 'tenant', capability: 'builder.edit', input: applyTemplateInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await applyTemplate(tenant, actor, requireUuidParam(params, 'templateId'), input) }),
});
