import { route } from '@/server/http/route';
import { publicTenant } from '@/server/domains/storefront-public';
import { acquisitionStatus, answerAcquisition } from '@/server/domains/customers/acquisition';
import { acquisitionAnswerInput } from '@/shared/schemas/customer-experience';

/** GET whether to ask «كيف عرفتِ عنا؟» (only when the source could not be inferred). */
export const GET = route({
  auth: 'user',
  handler: async ({ params, user }) => {
    const t = await publicTenant(params.slug!);
    return { data: await acquisitionStatus(t.id, user.userId) };
  },
});

/** POST her optional answer. Never overwrites a source inferred from a referral, campaign or platform. */
export const POST = route({
  auth: 'user', input: acquisitionAnswerInput,
  rateLimit: { scope: 'user', name: 'acquisition_answer', limit: 20, windowSec: 600 },
  handler: async ({ params, user, input, actor }) => {
    const t = await publicTenant(params.slug!);
    return { data: await answerAcquisition(t.id, user.userId, input.source, { ...actor, kind: 'customer' }) };
  },
});
