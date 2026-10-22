import { route } from '@/server/http/route';
import { getProgram, programInput, updateProgram } from '@/server/domains/loyalty/service';

export const GET = route({ auth: 'tenant', capability: 'loyalty.manage', feature: 'feature.loyalty', handler: async ({ tenant }) => ({ data: await getProgram(tenant) }) });
export const PUT = route({ auth: 'tenant', capability: 'loyalty.manage', feature: 'feature.loyalty', input: programInput, handler: async ({ tenant, actor, input }) => ({ data: await updateProgram(tenant, actor, input) }) });
