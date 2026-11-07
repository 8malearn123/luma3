import { platformRoute } from '@/server/domains/platform/guard';
import { referrerDetail, updateReferrer } from '@/server/domains/referrals/service';
import { requireUuidParam } from '@/server/http/params';
import { referrerUpdateInput } from '@/shared/schemas/admin';

/** GET /api/v1/platform/referrals/:id */
export const GET = platformRoute({
  platformCapability: 'platform.referrals.manage',
  handler: async ({ params }) => ({ data: await referrerDetail(requireUuidParam(params, 'id')) }),
});

/** PATCH /api/v1/platform/referrals/:id — rate, IBAN, status (versioned, step-up). */
export const PATCH = platformRoute({
  platformCapability: 'platform.referrals.manage', stepUp: true, input: referrerUpdateInput,
  handler: async ({ params, input, actor }) => ({ data: await updateReferrer(requireUuidParam(params, 'id'), actor, input) }),
});
