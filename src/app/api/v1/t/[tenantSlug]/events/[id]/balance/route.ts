import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { recordEventBalance } from '@/server/domains/events/service';
import { eventBalanceInput } from '@/shared/schemas/events';

/** POST record the balance collected on the day (cash / terminal, reference required). */
export const POST = route({
  auth: 'tenant', capability: 'payments.collect', idempotency: 'required', input: eventBalanceInput,
  handler: async ({ tenant, actor, params, input, idempotencyKey }) => {
    const r = await recordEventBalance(tenant, actor, requireUuidParam(params, 'id'), { amountMinor: input.amount_minor, method: input.method, reference: input.reference, idempotencyKey: idempotencyKey! });
    return { status: r.status, data: r.body };
  },
});
