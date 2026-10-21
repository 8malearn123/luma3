import { platformRoute } from '@/server/domains/platform/guard';
import { platformMarkInvoice } from '@/server/domains/subscriptions/service';
import { requireUuidParam } from '@/server/http/params';
import { invoiceMarkInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/invoices/:id — mark a test invoice paid (manual, no money moves) or void it (step-up). */
export const POST = platformRoute({
  platformCapability: 'platform.subscriptions.manage', stepUp: true, input: invoiceMarkInput,
  handler: async ({ params, actor, input }) => ({ data: await platformMarkInvoice(requireUuidParam(params, 'id'), actor, input) }),
});
