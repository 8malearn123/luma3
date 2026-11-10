import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { linkInvoiceLine } from '@/server/domains/commerce/purchasing';
import { invoiceLinkInput } from '@/shared/schemas/inventory';

/** Matches an invoice line to a received line (partial allowed). Never moves stock. */
export const POST = route({
  auth: 'tenant', capability: 'purchasing.manage', feature: 'feature.purchasing', input: invoiceLinkInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await linkInvoiceLine(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
