import { platformRoute } from '@/server/domains/platform/guard';
import { platformSettingsDetail, updatePlatformSettings } from '@/server/domains/platform/settings';
import { platformSettingsUpdateInput } from '@/shared/platform-settings';

/** GET /api/v1/platform/settings */
export const GET = platformRoute({
  platformCapability: 'platform.settings.manage',
  handler: async () => ({ data: await platformSettingsDetail() }),
});

/** PUT /api/v1/platform/settings — any subset of keys (platform owner + step-up, audited). */
export const PUT = platformRoute({
  platformCapability: 'platform.settings.manage', stepUp: true, input: platformSettingsUpdateInput,
  handler: async ({ input, actor }) => ({ data: await updatePlatformSettings(actor, input) }),
});
