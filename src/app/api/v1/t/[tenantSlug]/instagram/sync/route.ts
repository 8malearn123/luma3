import { route } from '@/server/http/route';
import { getInstagramSettings, syncInstagram } from '@/server/domains/instagram/service';

export const POST = route({
  auth: 'tenant', capability: ['builder.edit', 'business.manage'],
  rateLimit: { scope: 'user', name: 'instagram_sync', limit: 10, windowSec: 600 },
  handler: async ({ tenant }) => {
    const r = await syncInstagram(tenant.tenantId);
    return { data: { ...r, settings: await getInstagramSettings(tenant) } };
  },
});
