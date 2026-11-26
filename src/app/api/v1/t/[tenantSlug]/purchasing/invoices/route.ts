import { z } from 'zod';
import { route } from '@/server/http/route';
import { createInvoice, listInvoices } from '@/server/domains/commerce/purchasing';
import { invoiceInput } from '@/shared/schemas/inventory';

export const GET = route({
  auth: 'tenant', capability: ['purchasing.manage', 'purchasing.pay', 'finance.view'], feature: 'feature.purchasing',
  input: z.object({ status: z.enum(['draft', 'posted', 'void']).optional(), supplier_id: z.string().uuid().optional() }),
  handler: async ({ tenant, input }) => ({ data: await listInvoices(tenant, input) }),
});

/** Supplier invoice (separate from goods received; links never add stock). */
export const POST = route({
  auth: 'tenant', capability: 'purchasing.manage', feature: 'feature.purchasing', input: invoiceInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createInvoice(tenant, actor, input) }),
});
