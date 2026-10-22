import { route } from '@/server/http/route';
import { listMembers } from '@/server/domains/team/service';

export const GET = route({ auth: 'tenant', capability: 'team.manage', handler: async ({ tenant }) => ({ data: await listMembers(tenant) }) });
