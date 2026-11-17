import type { z } from 'zod';
import type { PlanAction, PlanDraft, PlanKind } from './plan';

/**
 * Host ports used by the planner (phase 3). Like the ActionPort, they are
 * implemented by the HOST (LUMA: src/server/loom-host/planner-port.ts) so the
 * Loom core never imports host domains or writes outside schema loom:
 *  - PlannerAiPort wraps the host's AI adapter (runAi: prompt registry,
 *    tenant-scoped cache, ai_runs provenance, monthly AI budget, model tier);
 *  - PlanStorePort stores plans in the host's append-only plan versions.
 * The host registers its implementation once with registerLoomHost().
 */
export type ModelTier = 'standard' | 'strong';

export type PlannerPrompt = { key: string; version: string; description: string; schemaName: string; modelTier: ModelTier; system: string };

export type PlannerAiCall<T> = {
  prompt: PlannerPrompt;
  /** Structured, redacted input (aggregates and pseudonymous refs only). */
  input: Record<string, unknown>;
  output: z.ZodType<T>;
  /** Redacted counts for ai_runs.input_summary. */
  inputSummary: Record<string, unknown>;
  /** Tenant-scoped cache key parts; the host adds the business, prompt and version (and filters by model). */
  cacheParts: Record<string, unknown> | null;
  maxOutputTokens?: number;
};

export type PlannerAiResult<T> = { output: T; runId: string; provider: string; model: string; cached: boolean };

export class PlannerAiError extends Error {
  constructor(readonly kind: string, message: string) { super(message); }
}

export interface PlannerAiPort {
  /** Whether a provider is configured (no network call). */
  available(): boolean;
  /** Atomically consumes one unit of the business's monthly AI budget; false = exhausted or not in plan. */
  consumeBudget(businessId: string): Promise<boolean>;
  /** One call with strict JSON output; throws PlannerAiError on any failure (never fabricates). */
  run<T>(businessId: string, call: PlannerAiCall<T>): Promise<PlannerAiResult<T>>;
}

export type HostPlanRef = {
  plan_id: string;
  kind: PlanKind;
  title: string;
  status: string;
  period: { from: string; to: string };
  is_example: boolean;
  current_version_id: string | null;
  current_version: number | null;
  approved_version_id: string | null;
  current_source: string | null;
  current_change_note: string | null;
  has_unapproved_changes: boolean;
};

export interface PlanStorePort {
  /** Live (not rejected/completed, not example) plan of this kind whose period contains `date`. */
  current(businessId: string, kind: PlanKind, date: string): Promise<HostPlanRef | null>;
  get(businessId: string, planId: string): Promise<HostPlanRef | null>;
  /** Open plans with an unapproved newer version (revision proposals awaiting a decision). */
  pendingRevisions(businessId: string): Promise<HostPlanRef[]>;
  /**
   * Appends a version (creates the plan when needed). An approved version is
   * never changed: approval is a separate host action.
   */
  saveVersion(businessId: string, v: {
    draft: PlanDraft; planId?: string | null; parentPlanId?: string | null; aiRunId?: string | null;
    validation: Record<string, unknown>; changeNote?: string | null; createdBy?: string | null;
  }): Promise<{ plan_id: string; version_id: string; version: number; created: boolean }>;
}

export type LoomHost = { ai: PlannerAiPort; plans: PlanStorePort };

let host: LoomHost | null = null;
/** Called once by the host at boot (LUMA: src/server/loom-host/planner-port.ts). */
export function registerLoomHost(h: LoomHost) { host = h; }
export function loomHost(): LoomHost {
  if (!host) throw new Error('Loom host ports are not registered (import the host planner port first)');
  return host;
}
export function hasLoomHost() { return host !== null; }

export type { PlanAction, PlanDraft };
