import { route } from '@/server/http/route';
import { generateDigestNow, listDigests } from '@/server/domains/business/digest';

export const GET = route({ auth: 'tenant', capability: ['business.manage', 'analytics.view'], handler: async ({ tenant }) => ({ data: await listDigests(tenant) }) });
/** Builds the digest for the last seven days now (idempotent per week). */
export const POST = route({ auth: 'tenant', capability: 'business.manage', handler: async ({ tenant, actor }) => ({ status: 201, data: await generateDigestNow(tenant, actor) }) });
