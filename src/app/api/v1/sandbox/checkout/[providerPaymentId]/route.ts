import { z } from 'zod';
import { route } from '@/server/http/route';
import { env } from '@/server/env';
import { Errors } from '@/server/http/errors';
import { handleWebhook } from '@/server/domains/payments/service';
import { requireSandboxActor } from '@/server/domains/payments/sandbox-access';
import { simulateSandboxOutcome } from '@/server/domains/payments/providers/sandbox';

/**
 * SANDBOX ONLY: simulates the hosted checkout outcome and delivers the signed
 * webhook the provider would send. Disabled in production.
 */
export const POST = route({
  auth: 'user',
  input: z.object({ outcome: z.enum(['captured', 'failed', 'cancelled']) }),
  rateLimit: { scope: 'user', name: 'sandbox_checkout', limit: 60, windowSec: 600 },
  handler: async ({ params, input, user }) => {
    if (env().isProduction) throw Errors.notFound();
    await requireSandboxActor(user, { providerPaymentId: params.providerPaymentId! });
    const ev = await simulateSandboxOutcome(params.providerPaymentId!, input.outcome);
    if (!ev) throw Errors.notFound('payment');
    const r = await handleWebhook('sandbox', ev.body, new Headers(ev.headers));
    return { data: { simulated: true, webhook: r.status } };
  },
});
