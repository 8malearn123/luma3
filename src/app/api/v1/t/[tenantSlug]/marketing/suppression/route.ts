import { z } from 'zod';
import { route } from '@/server/http/route';
import { addSuppression } from '@/server/domains/marketing/campaigns';


/** Manual opt-out / suppression (stored as a hash; never shown back). */
export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.campaigns',
  input: z.object({ channel: z.enum(['email', 'sms', 'whatsapp']), destination: z.string().trim().min(3).max(254) }).strict(),
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await addSuppression(tenant, actor, input.channel, input.destination) }),
});
