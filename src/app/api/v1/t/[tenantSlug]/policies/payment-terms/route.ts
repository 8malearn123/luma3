import { route } from '@/server/http/route';
import { previewTerms } from '@/server/domains/policy/service';
import { paymentTermsPreviewQuery } from '@/shared/schemas/policy';

/** GET — what checkout would offer this customer (effect only; platform reasons are never exposed). */
export const GET = route({
  auth: 'tenant', capability: ['customers.view', 'bookings.manage'], input: paymentTermsPreviewQuery,
  handler: async ({ tenant, input }) => ({ data: await previewTerms(tenant, input) }),
});
