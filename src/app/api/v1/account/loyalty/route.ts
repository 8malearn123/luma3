import { route } from '@/server/http/route';
import { myLoyalty } from '@/server/domains/loyalty/account';

/** GET her points balance and tier at each business she deals with. */
export const GET = route({ auth: 'user', handler: async ({ user }) => ({ data: await myLoyalty(user) }) });
