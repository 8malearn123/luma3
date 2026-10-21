import { route } from '@/server/http/route';
import { deleteOverride } from '@/server/domains/schedule/service';
import { requireUuidParam } from '@/server/http/params';

export const DELETE = route({ auth: 'tenant', capability: 'schedule.manage', handler: async ({ tenant, actor, params }) => ({ data: await deleteOverride(tenant, actor, requireUuidParam(params, 'id')) }) });
