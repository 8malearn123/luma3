import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { hasCapability } from '@/server/tenancy/access';
import { consentInput, loomModels } from '@/loom';
import { LOOM_CONNECTIONS, LOOM_FEATURE, LOOM_MANAGE, LOOM_VIEW, loomCtx } from '@/server/loom-host/access';

/** GET /loom/models/consent — shared-training consent (default false) with who/when. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomModels.getConsent({ businessId: tenant.tenantId, locale }) }),
});

/** PUT { shared_training_consent } — loom.manage AND the owner (business.manage), like the setup checklist; audited. */
export const PUT = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: consentInput,
  handler: async ({ tenant, actor, locale, input }) => {
    if (!hasCapability(tenant, LOOM_CONNECTIONS)) throw Errors.forbidden('Only the owner can decide shared-training consent', { reason: 'owner_only' });
    return { data: await loomModels.setConsent(loomCtx(tenant, actor, locale), input.shared_training_consent) };
  },
});
