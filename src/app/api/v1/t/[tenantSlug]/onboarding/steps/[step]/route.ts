import { z } from 'zod';
import { route } from '@/server/http/route';
import { saveStep } from '@/server/domains/onboarding/service';

/** PUT onboarding step 1-7. Body: { version, answers }. 409 on concurrent edits. */
export const PUT = route({
  auth: 'tenant',
  capability: 'business.manage',
  input: z.object({ version: z.number().int().min(1), answers: z.unknown() }),
  handler: async ({ tenant, actor, params, input }) => ({ data: await saveStep(tenant, actor, Number(params.step), input.answers, input.version) }),
});
