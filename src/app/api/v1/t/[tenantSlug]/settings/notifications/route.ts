import { route } from '@/server/http/route';
import { updateNotifications } from '@/server/domains/settings/service';
import { notificationsInput } from '@/shared/schemas/settings';

/** PUT /api/v1/t/:slug/settings/notifications — channel preferences (in-app always on). */
export const PUT = route({
  auth: 'tenant', capability: 'business.manage', input: notificationsInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateNotifications(tenant, actor, input) }),
});
