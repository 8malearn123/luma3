import { platformRoute } from '@/server/domains/platform/guard';
import { getTemplate, updateTemplate } from '@/server/domains/platform/templates';
import { requireUuidParam } from '@/server/http/params';
import { templatePatch } from '@/shared/schemas/platform';

/** GET/PUT /api/v1/platform/templates/:id (editing an approved template returns it to draft). */
export const GET = platformRoute({
  platformCapability: 'platform.templates.manage',
  handler: async ({ params }) => ({ data: await getTemplate(requireUuidParam(params, 'id')) }),
});
export const PUT = platformRoute({
  platformCapability: 'platform.templates.manage', input: templatePatch,
  handler: async ({ params, actor, input }) => ({ data: await updateTemplate(requireUuidParam(params, 'id'), actor, input) }),
});
