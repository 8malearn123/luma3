import { route } from '@/server/http/route';
import { myReviews, writeReview } from '@/server/domains/customers/account';
import { reviewInput } from '@/shared/schemas/customers';

/** GET — visits waiting for a review + reviews she wrote. */
export const GET = route({ auth: 'user', handler: async ({ user }) => ({ data: await myReviews(user) }) });

/** POST — one review per own completed visit. */
export const POST = route({
  auth: 'user', input: reviewInput, rateLimit: { scope: 'user', name: 'review', limit: 30, windowSec: 3600 },
  handler: async ({ user, actor, input }) => ({ status: 201, data: await writeReview(user, actor, input) }),
});
