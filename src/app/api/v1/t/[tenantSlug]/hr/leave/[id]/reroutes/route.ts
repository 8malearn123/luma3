import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { applyReroute, rerouteInput, rerouteSuggestions } from '@/server/domains/hr/reroute';

/** GET bookings affected by an approved leave, with suggested colleagues, and the reroute log. */
export const GET = route({
  auth: 'tenant', capability: 'bookings.manage',
  handler: async ({ tenant, params }) => ({ data: await rerouteSuggestions(tenant, requireUuidParam(params, 'id')) }),
});
/** POST reassign to a colleague (one click), reschedule, or cancel with customer notification. */
export const POST = route({
  auth: 'tenant', capability: 'bookings.manage', input: rerouteInput,
  handler: async ({ tenant, actor, params, input }) => ({ status: 201, data: await applyReroute(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
