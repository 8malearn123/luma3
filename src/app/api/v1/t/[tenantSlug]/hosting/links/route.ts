import { route } from '@/server/http/route';
import { listLinks, setLinks } from '@/server/domains/hosting/listings';
import { staffLinksInput } from '@/shared/schemas/hosting';

/** Chair ↔ staff links (D1b): a linked chair is busy while its staff have bookings. */
export const GET = route({ auth: 'tenant', capability: ['hosting.view', 'hosting.manage'], handler: async ({ tenant }) => ({ data: await listLinks(tenant) }) });
export const PUT = route({
  auth: 'tenant', capability: 'hosting.manage', input: staffLinksInput,
  handler: async ({ tenant, actor, input }) => ({ data: await setLinks(tenant, actor, input) }),
});
