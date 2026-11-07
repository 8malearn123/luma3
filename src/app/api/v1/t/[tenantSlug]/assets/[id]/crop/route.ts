import { z } from 'zod';
import { route, zUuid } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { cropExistingAsset, cropSchema, PURPOSE_CAPS, type UploadPurpose } from '@/server/domains/assets/service';
import { requireCapability } from '@/server/tenancy/access';

/** POST { crop, purpose } — cuts a new derived image from an existing one (the original is kept). */
export const POST = route({
  auth: 'tenant',
  rateLimit: { scope: 'user', name: 'upload', limit: 120, windowSec: 3600 },
  input: z.object({ crop: cropSchema, purpose: z.enum(Object.keys(PURPOSE_CAPS) as [UploadPurpose, ...UploadPurpose[]]) }),
  handler: async ({ tenant, actor, params, input }) => {
    if (!zUuid.safeParse(params.id).success) throw Errors.notFound('asset');
    requireCapability(tenant, PURPOSE_CAPS[input.purpose]);
    return { status: 201, data: await cropExistingAsset(tenant, actor, params.id!, input.crop, input.purpose) };
  },
});
