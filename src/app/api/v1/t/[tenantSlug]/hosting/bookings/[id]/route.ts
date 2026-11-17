import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getForHost } from '@/server/domains/hosting/bookings';

export const GET = route({ auth: 'tenant', capability: ['hosting.view', 'hosting.manage'], handler: async ({ tenant, params }) => ({ data: await getForHost(tenant, requireUuidParam(params, 'id')) }) });
