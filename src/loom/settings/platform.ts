import { z } from 'zod';
import { audit, withSystem, type AuditActor, type Tx } from '../db';

/**
 * Platform-level Loom settings (loom.loom_settings). These replace the open
 * decisions of §21: nothing here is hard-wired in the engine. Edited only by
 * the LUMA platform owner (step-up, audited). Values are validated by the
 * schemas below; a missing row means the default.
 */
export const RANKING_FACTORS = ['goal_fit', 'evidence', 'impact', 'feasibility', 'cost_effort', 'timing', 'risk'] as const;
export type RankingFactor = (typeof RANKING_FACTORS)[number];
export type RankingWeights = Record<RankingFactor, number>;

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = { goal_fit: 0.2, evidence: 0.2, impact: 0.2, feasibility: 0.15, cost_effort: 0.1, timing: 0.1, risk: 0.05 };

/** Weights are each within [0, max] and sum to 1 (± 0.001). */
export const rankingWeightsSchema = (max = 0.6) => z.object(Object.fromEntries(RANKING_FACTORS.map((f) => [f, z.number().min(0).max(max)])) as Record<RankingFactor, z.ZodNumber>)
  .strict().refine((w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) <= 0.001, { message: 'weights must sum to 1' });

export const eventSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  name: z.string().trim().min(2).max(120),
  url: z.string().url().max(500).regex(/^https:\/\//),
  region: z.string().trim().min(2).max(40),
  kind: z.enum(['official_calendar', 'school_calendar', 'religious_calendar', 'other']),
  license_note: z.string().trim().max(500),
  enabled: z.boolean(),
}).strict();

export const SECTOR_PACK_IDS = ['beauty', 'retail', 'restaurant', 'professional_services'] as const;

/**
 * Phase 6 (learned models, docs/LOOM_CORE.md §24). Margins are relative
 * improvements of the declared primary metric (lower is better) a candidate
 * must show over BOTH the baseline and the active version; guardrail metrics
 * may not be worse than either by more than `guardrail_tolerance`.
 */
export const learnedModelsSchema = z.object({
  enabled: z.boolean(),
  auto_promote: z.boolean(),
  promotion_margin: z.object({
    demand_forecast: z.number().min(0).max(0.5), return_probability: z.number().min(0).max(0.5), intervention_response: z.number().min(0).max(0.5),
  }).strict(),
  guardrail_tolerance: z.number().min(0).max(0.5),
  shadow_days: z.number().int().min(1).max(90),
  retrain_days: z.number().int().min(1).max(90),
  min_measured_outcomes: z.number().int().min(10).max(10_000),
  sector_models: z.boolean(),
}).strict();
export type LearnedModelSettings = z.infer<typeof learnedModelsSchema>;
export const LEARNED_MODEL_DEFAULTS: LearnedModelSettings = {
  enabled: false, auto_promote: true,
  promotion_margin: { demand_forecast: 0.05, return_probability: 0.02, intervention_response: 0.05 },
  guardrail_tolerance: 0.05, shadow_days: 14, retrain_days: 7, min_measured_outcomes: 30, sector_models: false,
};

export const platformSettingsSchema = z.object({
  default_ranking_weights: rankingWeightsSchema(),
  cost_completeness_threshold: z.number().min(0.5).max(1),
  learned_model_thresholds: z.object({ min_days: z.number().int().min(30).max(1095), min_completed_transactions: z.number().int().min(50).max(100_000) }).strict(),
  event_sources: z.array(eventSourceSchema).max(50).refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, { message: 'duplicate source id' }),
  enabled_sector_packs: z.array(z.enum(SECTOR_PACK_IDS)).min(1).max(SECTOR_PACK_IDS.length),
  learned_models: learnedModelsSchema,
}).strict();
export type LoomPlatformSettings = z.infer<typeof platformSettingsSchema>;
export const platformSettingsPatch = platformSettingsSchema.partial().strict().refine((p) => Object.keys(p).length > 0, { message: 'empty patch' });

export const PLATFORM_DEFAULTS: LoomPlatformSettings = {
  default_ranking_weights: DEFAULT_RANKING_WEIGHTS,
  cost_completeness_threshold: 0.8,
  learned_model_thresholds: { min_days: 180, min_completed_transactions: 500 },
  event_sources: [],
  enabled_sector_packs: ['beauty'],
  learned_models: LEARNED_MODEL_DEFAULTS,
};

const KEY = (k: keyof LoomPlatformSettings) => `platform.${k}`;

export async function readPlatformSettings(trx: Tx): Promise<LoomPlatformSettings & { _meta: Record<string, { version: number; updated_at: Date | null; is_default: boolean }> }> {
  const rows = await trx.selectFrom('loom.loom_settings').selectAll().execute();
  const out = { ...PLATFORM_DEFAULTS } as LoomPlatformSettings;
  const meta: Record<string, { version: number; updated_at: Date | null; is_default: boolean }> = {};
  for (const k of Object.keys(PLATFORM_DEFAULTS) as Array<keyof LoomPlatformSettings>) {
    const r = rows.find((x) => x.key === KEY(k));
    const parsed = r ? platformSettingsSchema.shape[k].safeParse(r.value) : null;
    if (parsed?.success) (out as Record<string, unknown>)[k] = parsed.data;
    meta[k] = { version: r?.version ?? 0, updated_at: r?.updated_at ?? null, is_default: !parsed?.success };
  }
  return { ...out, _meta: meta };
}

export async function getPlatformSettings() {
  return withSystem('loom: read platform settings', (trx) => readPlatformSettings(trx));
}

/** Platform owner only (enforced by the route); every changed key is audited with before/after. */
export async function updatePlatformSettings(actor: AuditActor, patch: Partial<LoomPlatformSettings>) {
  const parsed = platformSettingsSchema.partial().strict().parse(patch);
  return withSystem('loom: update platform settings', async (trx) => {
    const before = await readPlatformSettings(trx);
    for (const [k, v] of Object.entries(parsed) as Array<[keyof LoomPlatformSettings, unknown]>) {
      await trx.insertInto('loom.loom_settings').values({ key: KEY(k), value: JSON.stringify(v), updated_by: actor.userId, updated_at: new Date() })
        .onConflict((oc) => oc.column('key').doUpdateSet((eb) => ({ value: JSON.stringify(v), version: eb('loom.loom_settings.version', '+', 1), updated_by: actor.userId, updated_at: new Date() })))
        .execute();
      await audit(trx, actor, 'loom.platform_setting_updated', { targetType: 'loom_setting', targetId: null, data: { key: k, before: before[k], after: v } });
    }
    return readPlatformSettings(trx);
  });
}
