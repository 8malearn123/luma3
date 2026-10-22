import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { cancelEntry } from '@/server/domains/waitlist/service';

export const DELETE = route({ auth: 'tenant', capability: 'waitlist.manage', handler: async ({ tenant, actor, params }) => ({ data: await cancelEntry(tenant, actor, requireUuidParam(params, 'id')) }) });
