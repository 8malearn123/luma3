/**
 * Phase 6 contracts: learned models, their evaluation and governance
 * (docs/LOOM_MARKETING_ARCHITECTURE.md §10.4–§10.5, docs/LOOM_CORE.md §24).
 */
export const MODEL_KINDS = ['demand_forecast', 'return_probability', 'intervention_response'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export const MODEL_STATUSES = ['candidate', 'shadow', 'active', 'retired'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/**
 * Valid status transitions (mirrored by the trigger loom.guard_model_version).
 * retired → active is only the rollback of a version that was active before.
 */
export const MODEL_TRANSITIONS: Record<ModelStatus, ModelStatus[]> = {
  candidate: ['shadow', 'retired'],
  shadow: ['active', 'retired'],
  active: ['retired'],
  retired: ['active'],
};
export const canTransition = (from: ModelStatus, to: ModelStatus, wasActive = false) => MODEL_TRANSITIONS[from].includes(to) && (from !== 'retired' || wasActive);

/** Every evaluation metric is "lower is better". */
export type MetricKey = 'wape' | 'mae' | 'abs_bias' | 'brier' | 'log_loss' | 'ece';
export type Evaluation = {
  /** The declared primary metric of the kind. */
  primary: { key: MetricKey; value: number };
  guardrails: Array<{ key: MetricKey; value: number }>;
  n_test: number;
};

/** The temporal split: train on data ≤ split_at (T), evaluate on (T, test_to]. */
export type TemporalSplit = { train_from: string; train_to: string; split_at: string; test_from: string; test_to: string };

export type GateCheck = { against: 'baseline' | 'active'; metric: MetricKey; candidate: number; reference: number; required: number; passed: boolean };
export type GuardrailCheck = { against: 'baseline' | 'active'; metric: MetricKey; candidate: number; reference: number; limit: number; passed: boolean };
export type GateResult = {
  passed: boolean;
  metric: MetricKey;
  margin: number;
  guardrail_tolerance: number;
  checks: GateCheck[];
  guardrails: GuardrailCheck[];
  reasons: string[];
};

/** Result of fitting one kind for one business (pure; stored as a candidate version). */
export type TrainedModel = {
  kind: ModelKind;
  algorithm: string;
  split: TemporalSplit;
  params: Record<string, unknown>;
  candidate: Evaluation;
  baseline: Evaluation & { algorithm: string };
  n_train: number;
  data_hash: string;
  explain: Array<{ feature: string; effect: number }>;
};

export type KindOutcome =
  | { status: 'trained'; model: TrainedModel }
  | { status: 'insufficient'; reason: string; detail?: Record<string, number> };

/** A forecast row (before storage). */
export type ForecastRow = {
  model_kind: ModelKind;
  source: 'model' | 'baseline';
  model_version_id: string | null;
  version: number | null;
  algorithm: string;
  subject_key: string;
  subject: Record<string, unknown>;
  horizon_from: string;
  horizon_to: string;
  value: number;
  low: number;
  high: number;
  unit: 'count' | 'ratio';
};

/** What a success_metrics entry of kind model_forecast carries (never mixed with a proposed goal). */
export type { ForecastLabel } from '../contracts/opportunity';
