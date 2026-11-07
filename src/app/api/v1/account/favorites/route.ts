import { route } from '@/server/http/route';
import { addFavorite, explore } from '@/server/domains/marketplace/directory';
import { favoriteInput } from '@/shared/schemas/marketplace';

/** GET — her favourite businesses (those currently in the marketplace). */
export const GET = route({ auth: 'user', handler: async ({ user }) => ({ data: { items: (await explore(user.userId)).favorites } }) });

/** POST { slug } — add a marketplace business to favourites (idempotent). */
export const POST = route({
  auth: 'user', input: favoriteInput, rateLimit: { scope: 'user', name: 'favorite', limit: 120, windowSec: 3600 },
  handler: async ({ user, input }) => ({ status: 201, data: await addFavorite(user.userId, input.slug) }),
});
