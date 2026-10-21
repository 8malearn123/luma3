import { route } from '@/server/http/route';
import { listMyConsents, setMyConsent } from '@/server/domains/customers/account';
import { accountConsentInput } from '@/shared/schemas/customers';

/** GET — marketing/reminder consents per business she has a relationship with. */
export const GET = route({ auth: 'user', handler: async ({ user }) => ({ data: await listMyConsents(user) }) });

export const PUT = route({
  auth: 'user', input: accountConsentInput,
  handler: async ({ user, actor, input }) => ({ data: await setMyConsent(user, actor, input) }),
});
