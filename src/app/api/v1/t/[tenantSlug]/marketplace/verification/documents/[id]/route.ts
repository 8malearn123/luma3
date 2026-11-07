import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { tenantDocumentFile } from '@/server/domains/marketplace/listing';

/** GET — the owner's own verification document (private, never cached). */
export const GET = route({ auth: 'tenant', capability: 'business.manage', handler: async ({ tenant, params }) => tenantDocumentFile(tenant, requireUuidParam(params, 'id')) });
