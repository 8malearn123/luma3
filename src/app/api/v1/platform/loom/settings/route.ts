import { platformRoute } from '@/server/domains/platform/guard';
import { getPlatformSettings, platformSettingsPatch, updatePlatformSettings } from '@/loom';

/** GET /api/v1/platform/loom/settings — Loom platform settings with defaults and versions. */
export const GET = platformRoute({
  platformCapability: 'platform.loom.manage',
  handler: async () => {
    const { _meta, ...settings } = await getPlatformSettings();
    return { data: { settings, meta: _meta } };
  },
});

/** PUT — any subset of keys (platform owner + MFA + step-up; every key change is audited with before/after). */
export const PUT = platformRoute({
  platformCapability: 'platform.loom.manage', stepUp: true, input: platformSettingsPatch,
  handler: async ({ input, actor }) => {
    const { _meta, ...settings } = await updatePlatformSettings(actor, input);
    return { data: { settings, meta: _meta } };
  },
});
