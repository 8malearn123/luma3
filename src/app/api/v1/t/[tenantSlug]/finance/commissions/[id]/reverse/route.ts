import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { reverseCommission } from '@/server/domains/finance/service';

export const POST = route({ auth: 'tenant', capability: 'finance.manage', input: z.object({ reason: z.string().trim().min(3).max(300) }), handler: async ({ tenant, actor, params, input }) => ({ data: await reverseCommission(tenant, actor, requireUuidParam(params, 'id'), input.reason) }) });
