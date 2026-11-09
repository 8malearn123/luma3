import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { convertInput, loomApi } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';
import { lumaActionPort } from '@/server/loom-host/actions';

/**
 * POST /loom/opportunities/{id}/convert — plan_action | campaign_draft | price_proposal.
 * Loom builds the command; LUMA's ActionPort executes it with LUMA's rules
 * (campaign drafts need campaigns.approve to send; price proposals need catalog.edit and the owner's approval).
 */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: convertInput, idempotency: 'optional',
  handler: async ({ tenant, actor, locale, params, input }) => {
    if (!isUuid(params.id)) throw Errors.notFound('opportunity');
    const c = loomCtx(tenant, actor, locale);
    const cmd = await loomApi.conversionCommand(c, params.id, input);
    const result = await lumaActionPort(tenant, actor, locale).execute(tenant.tenantId, cmd);
    const opportunity = await loomApi.recordConversion(c, params.id, { target: result.target, ref_id: result.ref_id });
    return { status: 201, data: { result, opportunity } };
  },
});
