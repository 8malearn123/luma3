import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { checkoutSpace } from '@/server/domains/hosting/bookings';

/** Paid electronically to the host salon through its LUMA payment account (D3b). */
export const POST = route({
  auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book', idempotency: 'required', input: z.object({ return_url: z.string().regex(/^\/[A-Za-z0-9/_\-?=&.%]*$/).max(300).optional() }).strict(),
  handler: async ({ tenant, user, actor, params, input, idempotencyKey }) => {
    const id = requireUuidParam(params, 'id');
    const r = await checkoutSpace(tenant, user, actor, id, { idempotencyKey: idempotencyKey!, returnUrl: input.return_url ?? `/app/${tenant.slug}/workspace?booking=${id}` });
    return { status: r.status, data: r.body };
  },
});
