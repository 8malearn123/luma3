import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getForGuest } from '@/server/domains/hosting/bookings';

export const GET = route({ auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book', handler: async ({ tenant, params }) => ({ data: await getForGuest(tenant, requireUuidParam(params, 'id')) }) });
