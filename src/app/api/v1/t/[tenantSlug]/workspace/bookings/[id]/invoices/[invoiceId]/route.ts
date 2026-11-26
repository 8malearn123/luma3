import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { guestInvoice } from '@/server/domains/hosting/bookings';

/** Invoice issued by the host salon to this business (D13). */
export const GET = route({
  auth: 'tenant', capability: ['workspace.book', 'finance.view'],
  handler: async ({ tenant, params }) => ({ data: await guestInvoice(tenant, requireUuidParam(params, 'id'), requireUuidParam(params, 'invoiceId')) }),
});
