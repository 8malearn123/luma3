import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { sendQuote } from '@/server/domains/events/service';
import { eventQuoteInput } from '@/shared/schemas/events';

/** POST send (or revise) a quote: price, duration, deposit and expiry. The customer is notified. */
export const POST = route({
  auth: 'tenant', capability: 'bookings.manage', input: eventQuoteInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await sendQuote(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
