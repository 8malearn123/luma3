import { route } from '@/server/http/route';
import { getProfile, updateProfile } from '@/server/domains/customers/account';
import { accountProfilePatch } from '@/shared/schemas/customers';

export const GET = route({ auth: 'user', handler: async ({ user }) => ({ data: await getProfile(user) }) });

export const PATCH = route({
  auth: 'user', input: accountProfilePatch,
  handler: async ({ user, actor, input, responseInit }) => {
    const data = await updateProfile(user, actor, input);
    if (input.locale) responseInit.cookies.push({ name: 'luma_locale', value: input.locale, options: { path: '/', sameSite: 'lax', maxAge: 31_536_000 } });
    return { data };
  },
});
