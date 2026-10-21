import { route } from '@/server/http/route';
import { updateLegalTax } from '@/server/domains/settings/service';
import { legalTaxInput } from '@/shared/schemas/settings';

/** PUT /api/v1/t/:slug/settings/legal-tax — settings only; no tax/e-invoicing compliance is claimed. */
export const PUT = route({
  auth: 'tenant', capability: 'business.manage', input: legalTaxInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateLegalTax(tenant, actor, input) }),
});
