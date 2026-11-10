import { z } from 'zod';
import type { Localized } from '../util/text';

/** §11.1 opportunity card contract (loom.opportunity.v1) and §6.5 lifecycle. */
export const OPPORTUNITY_CATEGORIES = ['quiet_capacity', 'high_satisfaction_low_demand', 'lapsed_cohort', 'unserved_demand', 'conversion_friction',
  'cross_sell_affinity', 'slow_mover_bundle', 'margin_leak', 'missing_cost_blocker', 'offering_presentation', 'loyalty_over_discount',
  'capacity_prerequisite', 'campaign_learning',
  // phase 7 (retail pack)
  'stockout_risk'] as const;
export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];

export const ACTION_KINDS = ['content', 'package', 'value_add', 'reminder', 'open_slots', 'booking_ux', 'loyalty', 'limited_discount', 'price_review', 'staffing', 'restock'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const CHANNELS = ['in_app', 'whatsapp', 'sms', 'email', 'instagram', 'storefront', 'in_store'] as const;
export type Channel = (typeof CHANNELS)[number];

export const OPPORTUNITY_STATUSES = ['detected', 'assessed', 'proposed', 'studying', 'deferred', 'dismissed', 'accepted', 'converted', 'executed', 'measured', 'closed', 'superseded', 'expired'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
export const OPEN_STATUSES: OpportunityStatus[] = ['detected', 'assessed', 'proposed', 'studying'];

/** §10.1 categorised reasons (mandatory for dismiss and defer). */
export const DECISION_REASONS = ['capacity_staffing', 'capacity_inventory', 'budget', 'brand_fit', 'timing', 'already_doing', 'disagree_with_data', 'not_valuable', 'other'] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];
/** Rejections for these reasons are NOT a failure of the marketing idea. */
export const NON_IDEA_REASONS: DecisionReason[] = ['capacity_staffing', 'capacity_inventory', 'budget', 'timing'];

export type CapacityStatus = 'ok' | 'constrained' | 'blocked' | 'unknown';
export type InventoryStatus = 'ok' | 'constrained' | 'reorder_needed' | 'no_recipe' | 'not_applicable';
export type MarginStatus = 'ok' | 'thin' | 'negative' | 'costs_incomplete' | 'not_applicable';
export type EvidenceStrength = 'strong' | 'moderate' | 'limited' | 'insufficient';

export type SegmentDefinition = {
  conditions: Array<
    | { type: 'due_for_offering'; offering_id: string }
    | { type: 'visited_offering'; offering_id: string }
    | { type: 'not_visited_offering'; offering_id: string }
    | { type: 'last_visit_before_days'; days: number }
    | { type: 'has_consent'; channel?: string }
  >;
};

/** Bilingual internal card (what is stored in loom.opportunities.card). */
export type CardContent = {
  category: OpportunityCategory;
  title: Localized;
  period: { from: string; to: string };
  why_now: Localized;
  evidence_refs: string[];
  hypotheses: Array<{ text: Localized; status: 'hypothesis' }>;
  recommended_action: { kind: ActionKind; description: Localized; intervention_id: string; discount_bp?: number | null; direction?: 'increase_review' | null };
  alternatives_considered: Array<{ kind: ActionKind; intervention_id: string; rejected_because: Localized }>;
  target_segment: { definition: SegmentDefinition | Record<string, unknown>; size: number | null; size_status: 'counted' | 'insufficient' | 'unknown' };
  channel: Channel[];
  timing: { window: Localized; event_ref: string | null };
  estimated_cost: { amount_minor: number | null; basis: 'computed' | 'assumption' | 'unknown' };
  capacity_check: { status: CapacityStatus; max_additional: number | null; note: Localized };
  inventory_check: { status: InventoryStatus; covers_n: number | null; note?: Localized };
  margin_check: { status: MarginStatus; unit_margin_before_minor: number | null; unit_margin_after_minor: number | null; breakeven_volume_increase: number | null; note?: Localized };
  prerequisites: Localized[];
  draft_content: null;
  /**
   * Proposed goals (`proposed_goal`) and, separately, forecasts (`model_forecast`,
   * phase 6) — never mixed: a forecast entry carries `forecast` (source model |
   * baseline, version, 90% interval, horizon) and `baseline: null`.
   */
  success_metrics: SuccessMetric[];
  measurement_design: 'holdout' | 'ab' | 'pre_post_with_control' | 'observational';
  assumptions: Localized[];
  limitations: Localized[];
  data_quality: 'ok' | 'limited' | 'insufficient';
  priority: { rank: number; explanation: Localized; score: number; factors: Record<string, number>; evidence_strength: EvidenceStrength; bucket: 'top' | 'study' | 'blocked' };
  knowledge_refs: string[];
  review_at: string;
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Phase 6: the label of a forecast on a card or plan action (never on a proposed goal). */
export type ForecastLabel = {
  source: 'model' | 'baseline';
  model_kind: 'demand_forecast' | 'return_probability' | 'intervention_response';
  algorithm: string;
  model_version_id: string | null;
  version: number | null;
  low: number;
  high: number;
  interval: 0.9;
  horizon: { from: string; to: string };
  unit: 'count' | 'ratio';
};
export type SuccessMetric = { metric_key: string; baseline: number | null; target: number | null; target_kind: 'proposed_goal' | 'model_forecast'; forecast?: ForecastLabel };
export const forecastLabelSchema = z.object({
  source: z.enum(['model', 'baseline']),
  model_kind: z.enum(['demand_forecast', 'return_probability', 'intervention_response']),
  algorithm: z.string(),
  model_version_id: z.string().nullable(),
  version: z.number().int().nullable(),
  low: z.number(), high: z.number(), interval: z.literal(0.9),
  horizon: z.object({ from: isoDate, to: isoDate }).strict(),
  unit: z.enum(['count', 'ratio']),
}).strict();
export const successMetricSchema = z.object({
  metric_key: z.string(), baseline: z.number().nullable(), target: z.number().nullable(), target_kind: z.enum(['proposed_goal', 'model_forecast']), forecast: forecastLabelSchema.optional(),
}).strict().refine((m) => (m.target_kind === 'model_forecast') === !!m.forecast, { message: 'a forecast entry (and only a forecast entry) carries its forecast label' });

/** The rendered card, exactly §11.1 (one language, additionalProperties: false). */
export const opportunityCardSchema = z.object({
  opportunity_id: z.string(),
  business_id: z.string(),
  category: z.enum(OPPORTUNITY_CATEGORIES),
  title: z.string(),
  period: z.object({ from: isoDate, to: isoDate }).strict(),
  why_now: z.string(),
  evidence_refs: z.array(z.string().regex(/^ev_/)).min(1),
  hypotheses: z.array(z.object({ text: z.string(), status: z.literal('hypothesis') }).strict()),
  recommended_action: z.object({ kind: z.enum(ACTION_KINDS), description: z.string() }).strict(),
  alternatives_considered: z.array(z.object({ kind: z.enum(ACTION_KINDS), rejected_because: z.string() }).strict()),
  target_segment: z.object({ definition: z.record(z.string(), z.unknown()), size: z.number().int().nullable(), size_status: z.enum(['counted', 'insufficient', 'unknown']) }).strict(),
  channel: z.array(z.enum(CHANNELS)),
  timing: z.object({ window: z.string(), event_ref: z.string().nullable() }).strict(),
  estimated_cost: z.object({ amount_minor: z.number().int().nullable(), basis: z.enum(['computed', 'assumption', 'unknown']) }).strict(),
  capacity_check: z.object({ status: z.enum(['ok', 'constrained', 'blocked', 'unknown']), max_additional: z.number().int().nullable(), note: z.string() }).strict(),
  inventory_check: z.object({ status: z.enum(['ok', 'constrained', 'reorder_needed', 'no_recipe', 'not_applicable']), covers_n: z.number().int().nullable() }).strict(),
  margin_check: z.object({
    status: z.enum(['ok', 'thin', 'negative', 'costs_incomplete', 'not_applicable']),
    unit_margin_before_minor: z.number().int().nullable(), unit_margin_after_minor: z.number().int().nullable(), breakeven_volume_increase: z.number().nullable(),
  }).strict(),
  prerequisites: z.array(z.string()),
  draft_content: z.record(z.string(), z.unknown()).nullable(),
  success_metrics: z.array(successMetricSchema).min(1),
  measurement_design: z.enum(['holdout', 'ab', 'pre_post_with_control', 'observational']),
  assumptions: z.array(z.string()),
  limitations: z.array(z.string()),
  data_quality: z.enum(['ok', 'limited', 'insufficient']),
  priority: z.object({ rank: z.number().int(), explanation: z.string() }).passthrough(),
  knowledge_refs: z.array(z.string()),
  review_at: isoDate,
}).strict();
export type OpportunityCard = z.infer<typeof opportunityCardSchema>;
