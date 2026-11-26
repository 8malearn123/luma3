import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { hasCapability } from '@/server/tenancy/access';
import { loomApi, setupInput } from '@/loom';
import { LOOM_CONNECTIONS, LOOM_FEATURE, LOOM_MANAGE, LOOM_VIEW, loomCtx } from '@/server/loom-host/access';

/** GET /loom/setup — the REQUIRED setup checklist («مطلوب» until confirmed). */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: (await loomApi.getProfile({ businessId: tenant.tenantId, locale })).setup }),
});

/** PUT /loom/setup — confirms any subset of items. Shared-training consent is owner only (business.manage). */
export const PUT = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: setupInput,
  handler: async ({ tenant, actor, locale, input }) => {
    if (input.shared_training_consent !== undefined && !hasCapability(tenant, LOOM_CONNECTIONS)) throw Errors.forbidden('Only the owner can decide shared-training consent', { reason: 'owner_only' });
    return { data: await loomApi.putSetup(loomCtx(tenant, actor, locale), input) };
  },
});
