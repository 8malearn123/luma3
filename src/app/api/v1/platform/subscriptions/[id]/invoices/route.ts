import { platformRoute } from '@/server/domains/platform/guard';
import { platformIssueInvoice } from '@/server/domains/subscriptions/service';
import { requireUuidParam } from '@/server/http/params';
import { invoiceCreateInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/subscriptions/:id/invoices — issue a labelled TEST invoice (no charging). */
export const POST = platformRoute({
  platformCapability: 'platform.subscriptions.manage', stepUp: true, input: invoiceCreateInput,
  handler: async ({ params, actor, input }) => ({ status: 201, data: await platformIssueInvoice(requireUuidParam(params, 'id'), actor, input.note) }),
});
