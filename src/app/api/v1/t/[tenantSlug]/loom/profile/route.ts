import { route } from '@/server/http/route';
import { loomApi, profilePatchInput } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, LOOM_VIEW, loomCtx } from '@/server/loom-host/access';

/** GET /loom/profile — facts (computed / explicit / inferred), resolved preferences, goals and the setup checklist. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomApi.getProfile({ businessId: tenant.tenantId, locale }) }),
});

/** PATCH /loom/profile — explicit facts ({ facts: { key: value } }); unknown keys are rejected. */
export const PATCH = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: profilePatchInput,
  handler: async ({ tenant, actor, locale, input }) => ({ data: await loomApi.patchProfile(loomCtx(tenant, actor, locale), input.facts) }),
});
