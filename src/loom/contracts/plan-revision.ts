import type { Localized } from '../util/text';

/**
 * PlanRevisionPort (§11.2, §13, T10): how Loom asks the HOST to propose a new,
 * unapproved version of a plan that is already approved. The approved version
 * is never mutated; the host appends a revision version carrying the reason.
 *
 * Integration point: phase 3 (planner) adds `proposePlanRevision(businessId,
 * planId, reason, changes)` with plan_actions as tables. Until then the host
 * registers a default adapter (src/server/loom-host/plan-revisions.ts) that
 * appends a plan_versions row through LUMA's marketing plan functions. After
 * the planner merges, swap the adapter by calling `setPlanRevisionPort()` with
 * one that delegates to the planner — Loom's change aggregator does not change.
 */
export type PlanRevisionReason = { code: 'inventory' | 'occupancy' | 'capacity' | 'margin' | 'campaign_result'; text: Localized; signal_id: string };

export type PlanRevisionChange = {
  opportunity_id: string;
  initiative_id: string | null;
  /** The check that was re-run and its new status. */
  check: 'inventory' | 'capacity' | 'margin' | 'learning';
  status: string;
  /** What the revision proposes for the related plan items. */
  action: 'pause_promotion' | 'review' | 'restock_first' | 'note';
  title: Localized;
  evidence_refs: string[];
  note: Localized;
};

export type ApprovedPlanRef = { plan_id: string; approved_version_id: string; approved_version: number };
export type PlanRevisionResult = { plan_id: string; version_id: string; version: number };

export interface PlanRevisionPort {
  /** The plans among `planIds` that have an approved version in effect. */
  approvedPlans(businessId: string, planIds: string[]): Promise<ApprovedPlanRef[]>;
  /** Appends an UNAPPROVED revision version with the reason; never touches the approved one. */
  proposePlanRevision(businessId: string, planId: string, reason: PlanRevisionReason, changes: PlanRevisionChange[]): Promise<PlanRevisionResult>;
}

let port: PlanRevisionPort | null = null;
export function setPlanRevisionPort(p: PlanRevisionPort | null) { port = p; }
export function planRevisionPort(): PlanRevisionPort | null { return port; }
