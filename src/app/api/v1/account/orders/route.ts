import { route } from '@/server/http/route';
import { listMyOrders } from '@/server/domains/customers/account';

export const GET = route({ auth: 'user', handler: async ({ user }) => ({ data: await listMyOrders(user) }) });
