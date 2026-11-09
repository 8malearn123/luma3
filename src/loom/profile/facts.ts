import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tx } from '../db';
import { DEFAULT_RANKING_WEIGHTS, rankingWeightsSchema, type RankingWeights } from '../settings/platform';
import { L, type Localized } from '../util/text';

/**
 * Business profile (§8): every item is a fact with a kind (computed /
 * explicit / inferred), a source and dates. Precedence when the same key has
 * several kinds: explicit > computed > inferred. An inferred fact that
 * disagrees with an explicit one is flagged needs_review and never wins.
 */
export type FactKind = 'computed' | 'explicit' | 'inferred';
export type ProfileFact = {
  id: string; key: string; value: unknown; kind: FactKind;
  source: { type: 'metric' | 'user' | 'connector' | 'model'; ref: string | null };
  confidence: 'high' | 'medium' | 'low' | null; needs_review: boolean;
  valid_from: string; updated_at: string; updated_by: string | null;
};

export const GOAL_KINDS = ['fill_quiet_times', 'reactivate_customers', 'grow_offerings', 'increase_margin', 'increase_conversion', 'grow_new_customers', 'sell_products', 'improve_reviews'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];
export type Goal = { id: string; kind: GoalKind; priority: 'primary' | 'secondary'; offering_ids: string[]; note: string | null };

export const TONES = ['formal', 'friendly', 'warm_luxury', 'playful'] as const;

/** Explicit (user) fact keys and their value schemas. Anything else is rejected. */
export const EXPLICIT_FACTS = {
  'pref.monthly_budget_minor': z.number().int().min(0).max(1_000_000_000).nullable(),
  'pref.no_discounts': z.boolean(),
  'pref.max_discount_bp': z.number().int().min(0).max(9000),
  'pref.excluded_offerings': z.array(z.string().uuid()).max(200),
  'pref.growth_offerings': z.array(z.string().uuid()).max(50),
  'pref.tone': z.object({ style: z.enum(TONES), banned_words: z.array(z.string().trim().min(1).max(40)).max(30) }).strict(),
  'pref.ranking_weights': z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('default') }).strict(),
    z.object({ mode: z.literal('custom'), weights: rankingWeightsSchema(0.5) }).strict(),
  ]),
  'consent.shared_training': z.boolean(),
  'setup.goals': z.object({ confirmed: z.literal(true) }).strict(),
  'audience.core': z.string().trim().max(300),
} as const;
export type ExplicitKey = keyof typeof EXPLICIT_FACTS;
/** Competitor prices are explicit context facts: market.competitor_price:<offering_id>. */
export const competitorPriceKey = (offeringId: string) => `market.competitor_price:${offeringId}`;

/** Required setup items (§ product owner): plans have full confidence only when all are confirmed. */
export const SETUP_ITEMS = [
  { id: 'goals', keys: ['setup.goals'], label: L('الأهداف', 'Goals') },
  { id: 'monthly_budget', keys: ['pref.monthly_budget_minor'], label: L('الميزانية الشهرية', 'Monthly budget') },
  { id: 'discount_policy', keys: ['pref.no_discounts', 'pref.max_discount_bp'], label: L('سياسة الخصم', 'Discount policy') },
  { id: 'offerings_scope', keys: ['pref.excluded_offerings', 'pref.growth_offerings'], label: L('الخدمات المستبعدة والمراد تنميتها', 'Excluded and growth offerings') },
  { id: 'tone', keys: ['pref.tone'], label: L('نبرة المحتوى', 'Content tone') },
  { id: 'ranking_weights', keys: ['pref.ranking_weights'], label: L('أوزان الترتيب', 'Ranking weights') },
  { id: 'shared_training_consent', keys: ['consent.shared_training'], label: L('الموافقة على التدريب المشترك', 'Shared-training consent') },
] as const;
export type SetupItemId = (typeof SETUP_ITEMS)[number]['id'];

export type SetupStatus = { complete: boolean; items: Array<{ id: SetupItemId; label: Localized; required: true; confirmed: boolean; confirmed_at: string | null }>; missing: SetupItemId[] };

export type ResolvedProfile = {
  goals: Goal[];
  prefs: {
    no_discounts: boolean; max_discount_bp: number; monthly_budget_minor: number | null;
    excluded_offerings: string[]; growth_offerings: string[];
    tone: { style: string; banned_words: string[] } | null;
    ranking_weights: RankingWeights; weights_source: 'platform_default' | 'business';
    shared_training_consent: boolean;
  };
  competitor_prices: Record<string, number>;
  facts: ProfileFact[];
  setup: SetupStatus;
};

const PRECEDENCE: Record<FactKind, number> = { explicit: 3, computed: 2, inferred: 1 };

/** The winning fact per key (explicit > computed > inferred). */
export function effectiveFacts(facts: ProfileFact[]): Map<string, ProfileFact> {
  const out = new Map<string, ProfileFact>();
  for (const f of facts) { const cur = out.get(f.key); if (!cur || PRECEDENCE[f.kind] > PRECEDENCE[cur.kind]) out.set(f.key, f); }
  return out;
}

export function setupStatus(facts: ProfileFact[]): SetupStatus {
  const explicit = new Map(facts.filter((f) => f.kind === 'explicit').map((f) => [f.key, f]));
  const items = SETUP_ITEMS.map((it) => {
    const fs = it.keys.map((k) => explicit.get(k));
    const confirmed = fs.every(Boolean);
    return { id: it.id, label: it.label, required: true as const, confirmed, confirmed_at: confirmed ? fs.map((f) => f!.updated_at).sort().at(-1)! : null };
  });
  const missing = items.filter((i) => !i.confirmed).map((i) => i.id);
  return { complete: missing.length === 0, items, missing };
}

/** Pure resolution of the profile used by the engine. */
export function resolveProfile(facts: ProfileFact[], goals: Goal[], platformWeights: RankingWeights = DEFAULT_RANKING_WEIGHTS): ResolvedProfile {
  const eff = effectiveFacts(facts);
  const v = <T>(k: string, d: T): T => (eff.has(k) ? (eff.get(k)!.value as T) : d);
  const rw = v<{ mode: 'default' } | { mode: 'custom'; weights: RankingWeights } | null>('pref.ranking_weights', null);
  const competitor_prices: Record<string, number> = {};
  for (const [k, f] of eff) if (k.startsWith('market.competitor_price:') && typeof f.value === 'number') competitor_prices[k.split(':')[1]!] = f.value;
  const noDiscounts = v('pref.no_discounts', false);
  return {
    goals,
    prefs: {
      no_discounts: noDiscounts,
      max_discount_bp: noDiscounts ? 0 : v('pref.max_discount_bp', 2000),
      monthly_budget_minor: v<number | null>('pref.monthly_budget_minor', null),
      excluded_offerings: v<string[]>('pref.excluded_offerings', []),
      growth_offerings: v<string[]>('pref.growth_offerings', []),
      tone: v<{ style: string; banned_words: string[] } | null>('pref.tone', null),
      ranking_weights: rw?.mode === 'custom' ? rw.weights : platformWeights,
      weights_source: rw?.mode === 'custom' ? 'business' : 'platform_default',
      shared_training_consent: v<boolean>('consent.shared_training', false) === true && eff.get('consent.shared_training')?.kind === 'explicit',
    },
    competitor_prices,
    facts,
    setup: setupStatus(facts),
  };
}

// ── Storage ─────────────────────────────────────────────────────────────────
type Row = { id: string; key: string; value: unknown; kind: string; source_type: string; source_ref: string | null; confidence: string | null; needs_review: boolean; valid_from: Date; updated_at: Date; updated_by: string | null };
const toFact = (r: Row): ProfileFact => ({
  id: r.id, key: r.key, value: r.value, kind: r.kind as FactKind, source: { type: r.source_type as ProfileFact['source']['type'], ref: r.source_ref },
  confidence: r.confidence as ProfileFact['confidence'], needs_review: r.needs_review, valid_from: r.valid_from.toISOString(), updated_at: r.updated_at.toISOString(), updated_by: r.updated_by,
});

export async function loadFacts(trx: Tx, businessId: string): Promise<ProfileFact[]> {
  const rows = await trx.selectFrom('loom.business_profile_facts').selectAll().where('business_id', '=', businessId).where('superseded_by', 'is', null).orderBy('key').execute();
  return rows.map((r) => toFact(r as unknown as Row));
}

export async function loadGoals(trx: Tx, businessId: string): Promise<Goal[]> {
  const rows = await trx.selectFrom('loom.business_goals').select(['id', 'kind', 'priority', 'offering_ids', 'note']).where('business_id', '=', businessId).where('status', '=', 'active').orderBy('created_at').execute();
  return rows.map((r) => ({ id: r.id, kind: r.kind as GoalKind, priority: r.priority as Goal['priority'], offering_ids: r.offering_ids, note: r.note }));
}

/** Writes a fact, superseding the current one of the same key and kind when the value changed. Returns true if written. */
export async function writeFact(trx: Tx, businessId: string, f: { key: string; value: unknown; kind: FactKind; source_type: ProfileFact['source']['type']; source_ref?: string | null; confidence?: ProfileFact['confidence']; by?: string | null }) {
  const cur = await trx.selectFrom('loom.business_profile_facts').select(['id', 'value']).where('business_id', '=', businessId).where('key', '=', f.key)
    .where('kind', '=', f.kind).where('superseded_by', 'is', null).executeTakeFirst();
  if (cur && JSON.stringify(cur.value) === JSON.stringify(f.value) && f.kind !== 'explicit') return false;
  const id = randomUUID();
  if (cur) await trx.updateTable('loom.business_profile_facts').set({ superseded_by: id, superseded_at: new Date() }).where('id', '=', cur.id).execute();
  await trx.insertInto('loom.business_profile_facts').values({
    id, business_id: businessId, key: f.key, value: JSON.stringify(f.value), kind: f.kind, source_type: f.source_type, source_ref: f.source_ref ?? null,
    confidence: f.kind === 'inferred' ? f.confidence ?? 'low' : null, updated_by: f.by ?? null,
  }).execute();
  // An explicit value outranks any inferred one; a disagreeing inferred fact is flagged for review.
  if (f.kind === 'explicit') {
    await trx.updateTable('loom.business_profile_facts').set({ needs_review: true }).where('business_id', '=', businessId).where('key', '=', f.key)
      .where('kind', '=', 'inferred').where('superseded_by', 'is', null).execute();
  }
  return true;
}

export function validateExplicit(key: string, value: unknown): unknown {
  if (key.startsWith('market.competitor_price:')) {
    if (!/^market\.competitor_price:[0-9a-f-]{36}$/.test(key)) throw new Error('invalid_fact_key');
    return z.number().int().min(0).max(100_000_000).parse(value);
  }
  const schema = (EXPLICIT_FACTS as Record<string, z.ZodTypeAny>)[key];
  if (!schema) throw new Error('invalid_fact_key');
  return schema.parse(value);
}

export async function replaceGoals(trx: Tx, businessId: string, goals: Array<Omit<Goal, 'id'>>, by: string | null) {
  await trx.updateTable('loom.business_goals').set({ status: 'archived' }).where('business_id', '=', businessId).where('status', '=', 'active').execute();
  if (goals.length) {
    await trx.insertInto('loom.business_goals').values(goals.map((g) => ({ business_id: businessId, kind: g.kind, priority: g.priority, offering_ids: g.offering_ids, note: g.note, created_by: by }))).execute();
  }
  await writeFact(trx, businessId, { key: 'setup.goals', value: { confirmed: true }, kind: 'explicit', source_type: 'user', by });
}
