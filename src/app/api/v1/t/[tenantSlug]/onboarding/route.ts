import { route } from '@/server/http/route';
import { getOnboarding } from '@/server/domains/onboarding/service';

/** GET onboarding progress (resume from any device). */
export const GET = route({ auth: 'tenant', capability: 'business.manage', handler: async ({ tenant }) => ({ data: await getOnboarding(tenant) }) });
