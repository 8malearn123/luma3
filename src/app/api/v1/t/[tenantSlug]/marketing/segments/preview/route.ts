import { route } from '@/server/http/route';
import { previewSegment } from '@/server/domains/marketing/segments';
import { segmentPreviewInput } from '@/shared/schemas/marketing';


/** Audience size (counts only; a small named sample only for customers.view). Read-only. */
export const POST = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage', 'campaigns.approve'], feature: 'feature.campaigns', input: segmentPreviewInput, allowReadOnly: true,
  rateLimit: { scope: 'user', limit: 120, windowSec: 600, name: 'segment-preview' },
  handler: async ({ tenant, input }) => ({ data: await previewSegment(tenant, input.definition) }),
});
