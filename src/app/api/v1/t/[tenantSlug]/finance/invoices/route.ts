import { z } from 'zod';
import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { issueBookingInvoice } from '@/server/domains/finance/service';

export const GET = route({
  auth: 'tenant', capability: 'finance.view',
  handler: async ({ tenant }) => ({ data: await withTenant(tenant.tenantId, (trx) => trx.selectFrom('invoices').select(['id', 'number', 'kind', 'total_minor', 'currency', 'issued_at', 'booking_id', 'order_id', 'payment_id']).orderBy('issued_at', 'desc').limit(300).execute()) }),
});
export const POST = route({ auth: 'tenant', capability: ['finance.manage', 'payments.collect'], input: z.object({ booking_id: z.string().uuid() }), handler: async ({ tenant, actor, input }) => ({ status: 201, data: await issueBookingInvoice(tenant, actor, input.booking_id) }) });
