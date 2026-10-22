import { z } from 'zod';
import { route } from '@/server/http/route';
import { expenseInput, listExpenses, recordExpense } from '@/server/domains/finance/service';

const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const GET = route({ auth: 'tenant', capability: 'finance.view', input: z.object({ from: d, to: d }), handler: async ({ tenant, input }) => ({ data: await listExpenses(tenant, input.from, input.to) }) });
export const POST = route({ auth: 'tenant', capability: 'finance.manage', input: expenseInput, handler: async ({ tenant, actor, input }) => ({ status: 201, data: await recordExpense(tenant, actor, input) }) });
