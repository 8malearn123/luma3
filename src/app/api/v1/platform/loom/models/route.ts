import { platformRoute } from '@/server/domains/platform/guard';
import { loomModels, platformModelsInput } from '@/loom';

/** GET /api/v1/platform/loom/models — sector models (consenting businesses' aggregates only) and counts of business model versions. Thresholds, margins, shadow days and the switch live in /platform/loom/settings. */
export const GET = platformRoute({
  platformCapability: 'platform.loom.manage',
  handler: async () => ({ data: await loomModels.platformModels() }),
});

/** POST { action: train_sector | promote | rollback } — platform owner, step-up, audited. */
export const POST = platformRoute({
  platformCapability: 'platform.loom.manage', stepUp: true, input: platformModelsInput,
  handler: async ({ actor, input }) => ({ data: await loomModels.platformAction(actor, input) }),
});
