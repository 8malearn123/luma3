import { z } from 'zod';
import { route } from '@/server/http/route';
import { env } from '@/server/env';
import { Errors } from '@/server/http/errors';
import { handleWebhook } from '@/server/domains/payments/service';
import { simulateSandboxRefund } from '@/server/domains/payments/providers/sandbox';

/** SANDBOX ONLY: settles a pending sandbox refund (as the provider would) and delivers its webhook. */
export const POST = route({
  auth: 'user',
  input: z.object({ outcome: z.enum(['succeeded', 'failed']).default('succeeded') }),
  handler: async ({ params, input }) => {
    if (env().isProduction) throw Errors.notFound();
    const ev = await simulateSandboxRefund(params.providerRefundId!, input.outcome);
    if (!ev) throw Errors.notFound('refund');
    return { data: { simulated: true, webhook: (await handleWebhook('sandbox', ev.body, new Headers(ev.headers))).status } };
  },
});
