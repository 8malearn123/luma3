import { route } from '@/server/http/route';
import { explore } from '@/server/domains/marketplace/directory';
import { exploreQuery } from '@/shared/schemas/marketplace';

/** GET — «استكشفي»: favourites + "مقترحة لكِ" (same city, then top rated). */
export const GET = route({ auth: 'user', input: exploreQuery, handler: async ({ user, input }) => ({ data: await explore(user.userId, input) }) });
