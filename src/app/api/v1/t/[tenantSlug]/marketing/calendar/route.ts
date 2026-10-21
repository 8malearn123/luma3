import { route } from '@/server/http/route';
import { addCalendarEvent, listCalendar } from '@/server/domains/marketing/service';
import { calendarEventInput } from '@/shared/schemas/marketing';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  handler: async ({ tenant }) => ({ data: await listCalendar(tenant) }),
});

/** Adding a date is the owner's verification of it (Loom never invents dates). */
export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai', input: calendarEventInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await addCalendarEvent(tenant, actor, input) }),
});
