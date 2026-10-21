import { platformRoute } from '@/server/domains/platform/guard';
import { setTemplateStatus } from '@/server/domains/platform/templates';
import { requireUuidParam } from '@/server/http/params';
import { templateStatusInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/templates/:id/status — approve / retire / return to draft. */
export const POST = platformRoute({
  platformCapability: 'platform.templates.manage', input: templateStatusInput,
  handler: async ({ params, actor, input }) => ({ data: await setTemplateStatus(requireUuidParam(params, 'id'), actor, input) }),
});
