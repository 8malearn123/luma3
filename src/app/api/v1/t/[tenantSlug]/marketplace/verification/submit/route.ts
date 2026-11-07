import { route } from '@/server/http/route';
import { submitVerification } from '@/server/domains/marketplace/listing';

/** POST — send the uploaded documents to LUMA for verification. */
export const POST = route({ auth: 'tenant', capability: 'business.manage', handler: async ({ tenant, actor }) => ({ data: await submitVerification(tenant, actor) }) });
