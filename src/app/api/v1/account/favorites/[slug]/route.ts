import { route } from '@/server/http/route';
import { removeFavorite } from '@/server/domains/marketplace/directory';

/** DELETE — remove a business from her favourites. */
export const DELETE = route({ auth: 'user', handler: async ({ user, params }) => ({ data: await removeFavorite(user.userId, params.slug ?? '') }) });
