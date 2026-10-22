import { z } from 'zod';
import { route } from '@/server/http/route';
import { issueReceipt } from '@/server/domains/finance/service';

export const POST = route({ auth: 'tenant', capability: ['finance.view', 'payments.collect'], input: z.object({ payment_id: z.string().uuid() }), handler: async ({ tenant, actor, input }) => ({ status: 201, data: await issueReceipt(tenant, actor, input.payment_id) }) });
