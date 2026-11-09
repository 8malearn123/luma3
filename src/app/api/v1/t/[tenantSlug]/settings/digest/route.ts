import { route } from '@/server/http/route';
import { digestSettingsInput, getDigestSettings, saveDigestSettings } from '@/server/domains/business/digest';

/** Weekly owner digest schedule (day, local hour, or off). */
export const GET = route({ auth: 'tenant', capability: 'business.manage', handler: async ({ tenant }) => ({ data: await getDigestSettings(tenant) }) });
export const PUT = route({
  auth: 'tenant', capability: 'business.manage', input: digestSettingsInput,
  handler: async ({ tenant, actor, input }) => ({ data: await saveDigestSettings(tenant, actor, input) }),
});
