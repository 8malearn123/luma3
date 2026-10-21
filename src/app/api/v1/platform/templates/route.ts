import { z } from 'zod';
import { platformRoute } from '@/server/domains/platform/guard';
import { createTemplate, listTemplates } from '@/server/domains/platform/templates';
import { templateInput } from '@/shared/schemas/platform';

/** GET/POST /api/v1/platform/templates */
export const GET = platformRoute({
  platformCapability: 'platform.templates.manage', input: z.object({ status: z.enum(['draft', 'approved', 'retired']).optional() }),
  handler: async ({ input }) => ({ data: await listTemplates(input.status) }),
});
export const POST = platformRoute({
  platformCapability: 'platform.templates.manage', input: templateInput,
  handler: async ({ actor, input }) => ({ status: 201, data: await createTemplate(actor, input) }),
});
