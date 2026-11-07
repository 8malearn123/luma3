import { platformRoute } from '@/server/domains/platform/guard';
import { platformDocumentFile } from '@/server/domains/marketplace/listing';
import { requireUuidParam } from '@/server/http/params';

/** GET — a verification document for a reviewer (MFA-guarded, audited, never cached). */
export const GET = platformRoute({ platformCapability: 'platform.marketplace.review', handler: async ({ params, actor }) => platformDocumentFile(requireUuidParam(params, 'id'), actor) });
