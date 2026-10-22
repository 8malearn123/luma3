import { route } from '@/server/http/route';
import { readiness } from '@/server/domains/onboarding/service';

/** GET pre-publication readiness checklist. */
export const GET = route({ auth: 'tenant', capability: ['business.manage', 'builder.edit'], handler: async ({ tenant }) => ({ data: await readiness(tenant) }) });
