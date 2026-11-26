import { platformRoute } from '@/server/domains/platform/guard';
import { loomBusinesses } from '@/loom';

/**
 * External (Loom-only) businesses, operated by the platform owner. They have
 * no LUMA tenant; Loom isolates them by their own business id (RLS scope).
 */
export const GET = platformRoute({
  platformCapability: 'platform.loom.manage',
  handler: async ({ locale }) => ({ data: { businesses: await loomBusinesses.listExternal(), packs: await loomBusinesses.packChoices(locale) } }),
});

/** POST — create (pack must be enabled by the platform). Step-up. */
export const POST = platformRoute({
  platformCapability: 'platform.loom.manage', stepUp: true, input: loomBusinesses.externalBusinessInput,
  handler: async ({ actor, input }) => ({ status: 201, data: await loomBusinesses.createExternal(actor, input) }),
});
