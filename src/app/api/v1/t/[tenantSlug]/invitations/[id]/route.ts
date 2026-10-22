import { route } from '@/server/http/route';
import { revokeInvitation } from '@/server/domains/team/service';
import { requireUuidParam } from '@/server/http/params';

export const DELETE = route({ auth: 'tenant', capability: 'team.manage', handler: async ({ tenant, actor, params }) => ({ data: await revokeInvitation(tenant, actor, requireUuidParam(params, 'id')) }) });
