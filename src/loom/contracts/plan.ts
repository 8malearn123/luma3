import type { ActionKind, CapacityStatus, Channel, InventoryStatus, SuccessMetric } from './opportunity';
import type { Localized } from '../util/text';

/**
 * §11.2 plan contract produced by the Loom planner (AI or rules, same shape).
 * Bilingual; the host renders it into its own plan storage (in LUMA:
 * marketing_plans / plan_versions) and Loom keeps every action as a row in
 * loom.plan_actions linked to the stored version and to its opportunity.
 */
export type PlanKind = 'monthly' | 'weekly';
export type PlanSource = 'ai' | 'rules';

/** A highlighted offering in a weekly plan: real free slots and the materials it needs. */
export type HighlightedOffering = {
  offering_id: string;
  name: Localized;
  /** Bookable slots for qualified staff inside the week (computed); null = no schedule. */
  free_slots: number | null;
  /** Up to 5 example slot starts (business-local "YYYY-MM-DD HH:mm"). */
  sample_slots: string[];
  materials: Array<{ name: string; per_service: number; unit: string; available: number }>;
  materials_status: InventoryStatus;
};

export type PlanAction = {
  /** Stable within a version: la_<seq>. */
  ref: string;
  seq: number;
  opportunity_id: string | null;
  role: 'initiative' | 'prerequisite' | 'measurement';
  action_kind: ActionKind;
  intervention_id: string | null;
  title: Localized;
  description: Localized;
  content_idea: Localized | null;
  audience: { definition: Record<string, unknown>; size: number | null; size_status: 'counted' | 'insufficient' | 'unknown'; label: Localized };
  channels: Channel[];
  schedule: { from: string; to: string };
  /** A role, not a person (LUMA has no assignment yet): owner / reception / specialist. */
  owner: Localized;
  budget: { amount_minor: number | null; basis: 'computed' | 'assumption' | 'unknown' };
  /** Operational requirements from the capacity / inventory checks. */
  operational: {
    capacity: { status: CapacityStatus; max_additional: number | null; note: Localized };
    inventory: { status: InventoryStatus; covers_n: number | null; note: Localized | null };
    requirements: Localized[];
  };
  highlighted: HighlightedOffering[];
  success_metrics: SuccessMetric[];
  evidence_refs: string[];
  knowledge_refs: string[];
  /** Set on actions changed by a revision proposal. */
  revision_note?: Localized | null;
};

export type PlanDraft = {
  kind: PlanKind;
  period: { from: string; to: string };
  title: Localized;
  /** One-line goal statement (from the profile goals; AI or rules wording). */
  goal: Localized;
  /** From the profile goals (kind + title); empty when no goal is confirmed. */
  goals: Array<{ id: string; kind: string; title: Localized }>;
  /** Computed baseline (metric values of the latest analysis). */
  baseline: Array<{ metric_key: string; label: Localized; value: number | null }>;
  actions: PlanAction[];
  budget: { total_minor: number | null; business_budget_minor: number | null; status: 'within_budget' | 'over_budget' | 'unknown' | 'no_budget_set' };
  success_metrics: Array<{ metric_key: string; label: Localized; baseline: number | null; proposed_target: number | null }>;
  limitations: Localized[];
  /** Visible notes (e.g. «خطة بالقواعد» and why). */
  notes: Localized[];
  source: PlanSource;
  experimental: boolean;
  review_at: string;
};

/** A change proposed after approval (T10). Applied to the latest version's actions, saved as a NEW unapproved version. */
export type PlanRevisionChange =
  | { kind: 'pause_action'; action_ref: string; note: Localized }
  | { kind: 'remove_action'; action_ref: string; note: Localized }
  | { kind: 'reschedule_action'; action_ref: string; schedule: { from: string; to: string }; note: Localized }
  | { kind: 'add_requirement'; action_ref: string; requirement: Localized; note: Localized }
  | { kind: 'pause_opportunity'; opportunity_id: string; note: Localized };
