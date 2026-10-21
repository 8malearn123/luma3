import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { customerReceipt } from '@/server/domains/booking/customer';
import { invoiceHtml } from '@/server/domains/finance/documents';

/** GET a printable receipt/invoice for the customer's own booking (HTML print view). */
export const GET = route({
  auth: 'user',
  handler: async ({ user, params, locale }) => {
    const inv = await customerReceipt(user.userId, requireUuidParam(params, 'id'), requireUuidParam(params, 'receiptId'));
    return new Response(invoiceHtml(inv, locale), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  },
});
