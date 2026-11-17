import { route } from '@/server/http/route';
import { archivePackage, updatePackage } from '@/server/domains/catalog/service';
import { requireUuidParam } from '@/server/http/params';
import { packagePatch } from '@/shared/schemas/catalog';

/** PATCH edits the package for new sales (existing bookings and entitlements keep their own snapshots). */
export const PATCH = route({
  auth: 'tenant', capability: 'catalog.edit', input: packagePatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updatePackage(tenant, actor, requireUuidParam(params, 'id'), input) }),
});

export const DELETE = route({
  auth: 'tenant', capability: 'catalog.edit',
  handler: async ({ tenant, actor, params }) => ({ data: await archivePackage(tenant, actor, requireUuidParam(params, 'id')) }),
});
