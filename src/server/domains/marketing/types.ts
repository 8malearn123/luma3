import type { PlanContent } from '@/shared/schemas/marketing';
import type { RECOMMENDATION_CATEGORIES } from '@/shared/schemas/marketing';

export type RecCategory = (typeof RECOMMENDATION_CATEGORIES)[number];

export type CostEstimate = { status: 'unknown' | 'estimate' | 'none'; amount_minor: number | null; assumptions: string };
export type CapacityCheck = { status: 'ok' | 'limited' | 'insufficient_capacity' | 'not_applicable' | 'unknown'; free_min_next14?: number | null; avoided_full_slots?: string[]; note?: string };
export type MarginCheck = { status: 'ok' | 'low_margin' | 'costs_incomplete' | 'not_applicable'; min_margin_ratio?: number | null; services_missing_costs?: string[]; discount_bp?: number | null; note?: string };

/** Everything a recommendation row requires (§28). */
export type RecDraft = {
  title: string;
  category: RecCategory;
  horizon: 'weekly' | 'monthly' | 'ongoing';
  period_start: string | null;
  period_end: string | null;
  evidence_refs: string[];
  measured_metrics: Record<string, { value: number | null; supported: boolean; claimed?: number | null }>;
  opportunity: string;
  suggested_action: string;
  timing: string;
  estimated_cost: CostEstimate;
  capacity_check: CapacityCheck;
  margin_check: MarginCheck;
  draft_content: { text: string | null; segment_definition?: unknown; service_ids?: string[] } | null;
  channel: string | null;
  prerequisites: string[];
  success_metric: string;
  experiment_design: string;
  confidence: 'low' | 'medium' | 'high';
  limitations: string;
  /** A goal for the owner to adopt — not a promise. */
  proposed_target: string | null;
  /** Rules never forecast; AI forecasts must be supported or are dropped. */
  forecast: string | null;
  fingerprint: string;
  service_ids: string[];
  validation: Record<string, unknown>;
};

export type GeneratedPlan = { title: string; content: PlanContent };

export type Provenance = { source_type: 'ai' | 'rules' | 'example'; provider: string | null; model: string | null; prompt_version: string; ai_run_id: string | null };
