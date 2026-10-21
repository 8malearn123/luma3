import { route } from '@/server/http/route';
import { generateDraft } from '@/server/domains/onboarding/service';

/** POST — build the initial storefront DRAFT from the answers (deterministic rules; never publishes). */
export const POST = route({ auth: 'tenant', capability: 'business.manage', handler: async ({ tenant, actor }) => ({ data: await generateDraft(tenant, actor) }) });
