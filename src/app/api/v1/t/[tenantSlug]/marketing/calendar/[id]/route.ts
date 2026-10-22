import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { deleteCalendarEvent } from '@/server/domains/marketing/service';


export const DELETE = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai',
  handler: async ({ tenant, actor, params }) => ({ data: await deleteCalendarEvent(tenant, actor, requireUuidParam(params, 'id')) }),
});
