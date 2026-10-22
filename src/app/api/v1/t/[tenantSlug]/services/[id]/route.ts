import { route } from '@/server/http/route';
import { getService, updateService } from '@/server/domains/catalog/service';
import { servicePatch } from '@/shared/schemas/catalog';
import { requireUuidParam } from '@/server/http/params';

export const GET = route({
  auth: 'tenant', capability: ['catalog.edit', 'bookings.view_all', 'bookings.view_assigned'],
  handler: async ({ tenant, params }) => ({ data: await getService(tenant, requireUuidParam(params, 'id')) }),
});

/** PATCH with { version }: 409 version_conflict on concurrent edits. */
export const PATCH = route({
  auth: 'tenant', capability: 'catalog.edit', input: servicePatch,
  handler: async ({ tenant, actor, input, params }) => ({ data: await updateService(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
