import { platformRoute } from '@/server/domains/platform/guard';
import { marketplaceSettings, updateMarketplaceSettings } from '@/server/domains/marketplace/listing';
import { marketSettingsInput } from '@/shared/schemas/marketplace';

/** GET — marketplace settings (verification required to join, default commission). */
export const GET = platformRoute({ platformCapability: 'platform.marketplace.review', handler: async () => ({ data: await marketplaceSettings() }) });

/** PUT — change marketplace settings (platform owner, step-up). */
export const PUT = platformRoute({
  platformCapability: 'platform.marketplace.manage', stepUp: true, input: marketSettingsInput,
  handler: async ({ actor, input }) => ({ data: await updateMarketplaceSettings(actor, input) }),
});
