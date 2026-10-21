import { route } from '@/server/http/route';
import { myPolicy } from '@/server/domains/customers/account';

/** GET — decisions and confirmed incidents about the signed-in customer (effect + explanation only). */
export const GET = route({ auth: 'user', handler: async ({ user }) => ({ data: await myPolicy(user) }) });
