import { randomBytes } from 'node:crypto';
import type { Tx } from '../db';
import { NON_IDEA_REASONS, OPEN_STATUSES, type CardContent, type DecisionReason, type OpportunityStatus } from '../contracts/opportunity';
import type { AssessedOpportunity } from './engine';
import { countsAsIdeaFailure, inferBrandFit, recordLadder } from '../memory/ladder';

/**
 * Persistence and lifecycle (§6.5). One row per fingerprint; a re-detected
 * open opportunity gets new evidence and checks (append-only) instead of a
 * duplicate. States: detected → assessed → proposed → (studying | deferred |
 * dismissed | accepted) → converted → executed → measured → closed, plus
 * superseded / expired when the causes change.
 */
export const newEvidenceId = () => `ev_${randomBytes(10).toString('hex')}`;

type EventIn = { event: string; from: string | null; to: string | null; reason?: string | null; note?: string | null; counts_as_idea_failure?: boolean | null; data?: Record<string, unknown>; actor?: string | null; analysis?: string | null };

export async function recordEvent(trx: Tx, businessId: string, opportunityId: string, e: EventIn) {
  await trx.insertInto('loom.opportunity_events').values({
    business_id: businessId, opportunity_id: opportunityId, analysis_id: e.analysis ?? null, event: e.event, from_status: e.from, to_status: e.to,
    reason: e.reason ?? null, note: e.note ?? null, counts_as_idea_failure: e.counts_as_idea_failure ?? null, data: JSON.stringify(e.data ?? {}), actor_id: e.actor ?? null,
  }).execute();
}

/** Volume reserved on each offering by accepted / converted initiatives (deducted first by the capacity check). */
export async function reservedVolumes(trx: Tx, businessId: string): Promise<Map<string, number>> {
  const rows = await trx.selectFrom('loom.opportunities').select(['subject']).where('business_id', '=', businessId).where('status', 'in', ['accepted', 'converted', 'executed']).execute();
  const m = new Map<string, number>();
  for (const r of rows) {
    const s = r.subject as { reserve?: { offering_id: string | null; volume: number | null } };
    if (s.reserve?.offering_id && s.reserve.volume) m.set(s.reserve.offering_id, (m.get(s.reserve.offering_id) ?? 0) + s.reserve.volume);
  }
  return m;
}

export type PersistSummary = { created: number; updated: number; reopened: number; expired: number; kept_closed: number };

/**
 * Constraints that may have cleared since a non-idea rejection (§10.1, T13):
 * a budget dismissal resurfaces once the budget preference was changed after
 * the decision; a timing dismissal once `timing_resurface_days` have passed.
 */
export type ConstraintState = { budgetUpdatedAt?: Date | null; timingResurfaceDays?: number };

export async function persistOpportunities(trx: Tx, businessId: string, analysisId: string, items: AssessedOpportunity[], opts: { today: string; sectorPack: string; sectorPackVersion: string; constraints?: ConstraintState }): Promise<PersistSummary> {
  const sum: PersistSummary = { created: 0, updated: 0, reopened: 0, expired: 0, kept_closed: 0 };
  const seen = new Set<string>();
  for (const o of items) {
    seen.add(o.fingerprint);
    const existing = await trx.selectFrom('loom.opportunities').selectAll().where('business_id', '=', businessId).where('fingerprint', '=', o.fingerprint).forUpdate().executeTakeFirst();
    let status: OpportunityStatus = 'proposed';
    let id: string;
    let reopenReason: string | null = null;
    if (existing) {
      const cur = existing.status as OpportunityStatus;
      if (OPEN_STATUSES.includes(cur)) status = cur === 'studying' ? 'studying' : 'proposed';
      else if (cur === 'deferred') {
        status = existing.deferred_until && existing.deferred_until <= opts.today ? 'proposed' : 'deferred';
        if (status === 'proposed') reopenReason = 'defer_elapsed';
      } else if (cur === 'dismissed' || cur === 'expired' || cur === 'superseded') {
        // A rejection for capacity reasons is not a verdict on the idea: re-offer it once the constraint is gone (T13).
        const reason = existing.decision_reason as DecisionReason | null;
        const capacityFreed = reason === 'capacity_staffing' && (o.checks.capacity.status === 'ok') && o.category !== 'capacity_prerequisite';
        const stockFreed = reason === 'capacity_inventory' && ['ok', 'constrained', 'not_applicable'].includes(o.checks.inventory.status);
        const budgetFreed = reason === 'budget' && !!existing.decided_at && !!opts.constraints?.budgetUpdatedAt && opts.constraints.budgetUpdatedAt > existing.decided_at;
        const timingFreed = reason === 'timing' && !!existing.decided_at && Date.parse(`${opts.today}T00:00:00Z`) - existing.decided_at.getTime() >= (opts.constraints?.timingResurfaceDays ?? 30) * 86_400_000;
        if (cur !== 'dismissed') { status = 'proposed'; reopenReason = 'detected_again'; }
        else if (capacityFreed || stockFreed || budgetFreed || timingFreed) {
          status = 'proposed';
          reopenReason = capacityFreed ? 'capacity_available' : stockFreed ? 'inventory_available' : budgetFreed ? 'budget_available' : 'timing_elapsed';
        }
        else { sum.kept_closed++; continue; }
      } else { sum.kept_closed++; continue; } // accepted / converted / executed / measured / closed keep their decision
      id = existing.id;
    }
    const evidenceIds = o.evidence.map(() => newEvidenceId());
    const card: CardContent = { ...o.card, evidence_refs: evidenceIds };
    const values = {
      detector_id: o.detector_id, category: o.category, status, subject: JSON.stringify({ ...o.subject, reserve: o.reserve }), card: JSON.stringify(card),
      priority_rank: o.card.priority.rank, priority_score: o.card.priority.score, display_bucket: o.card.priority.bucket, evidence_strength: o.evidence_strength,
      data_quality: o.card.data_quality, sector_pack: opts.sectorPack, sector_pack_version: opts.sectorPackVersion, period_from: o.card.period.from, period_to: o.card.period.to,
      review_at: o.card.review_at, last_analysis_id: analysisId,
    };
    if (existing) {
      await trx.updateTable('loom.opportunities').set({ ...values, ...(reopenReason ? { decision_reason: null, decided_at: null, decided_by: null, deferred_until: null } : {}) }).where('id', '=', existing.id).execute();
      if (reopenReason) { sum.reopened++; await recordEvent(trx, businessId, existing.id, { event: 'reopened', from: existing.status, to: status, reason: reopenReason, analysis: analysisId }); }
      else { sum.updated++; await recordEvent(trx, businessId, existing.id, { event: 'reassessed', from: existing.status, to: status, analysis: analysisId, data: { rank: o.card.priority.rank } }); }
    } else {
      const row = await trx.insertInto('loom.opportunities').values({ business_id: businessId, fingerprint: o.fingerprint, first_analysis_id: analysisId, ...values }).returning('id').executeTakeFirstOrThrow();
      id = row.id;
      sum.created++;
      await recordEvent(trx, businessId, id, { event: 'detected', from: null, to: 'detected', analysis: analysisId, data: { detector: o.detector_id } });
      await recordEvent(trx, businessId, id, { event: 'proposed', from: 'assessed', to: 'proposed', analysis: analysisId, data: { evidence_strength: o.evidence_strength, rank: o.card.priority.rank } });
    }
    if (o.evidence.length) {
      await trx.insertInto('loom.opportunity_evidence').values(o.evidence.map((e, i) => ({
        id: evidenceIds[i]!, business_id: businessId, opportunity_id: id!, analysis_id: analysisId, metric_key: e.metric_key, grain_ref: e.grain_ref,
        value: e.value, n: e.n, label: JSON.stringify(e.label), grade: e.grade,
      }))).execute();
    }
    await trx.insertInto('loom.opportunity_checks').values([
      { business_id: businessId, opportunity_id: id!, analysis_id: analysisId, check_type: 'capacity', status: o.checks.capacity.status, details: JSON.stringify(o.checks.capacity) },
      { business_id: businessId, opportunity_id: id!, analysis_id: analysisId, check_type: 'inventory', status: o.checks.inventory.status, details: JSON.stringify(o.checks.inventory) },
      { business_id: businessId, opportunity_id: id!, analysis_id: analysisId, check_type: 'margin', status: o.checks.margin.status, details: JSON.stringify(o.checks.margin) },
      { business_id: businessId, opportunity_id: id!, analysis_id: analysisId, check_type: 'preferences', status: o.checks.preferences.status, details: JSON.stringify(o.checks.preferences) },
    ]).execute();
  }
  // Open opportunities that were not detected again: their causes changed.
  const stale = await trx.selectFrom('loom.opportunities').select(['id', 'status', 'fingerprint']).where('business_id', '=', businessId).where('status', 'in', OPEN_STATUSES).execute();
  for (const s of stale) {
    if (seen.has(s.fingerprint)) continue;
    await trx.updateTable('loom.opportunities').set({ status: 'expired', display_bucket: null }).where('id', '=', s.id).execute();
    await recordEvent(trx, businessId, s.id, { event: 'expired', from: s.status, to: 'expired', reason: 'conditions_changed', analysis: analysisId });
    sum.expired++;
  }
  return sum;
}

// ── Decisions (§10.1) ───────────────────────────────────────────────────────
/** Owner edits applied when approving ("edit + approve"); kept as a diff on the initiative record. */
export type DecisionEdits = { description?: string; channel?: string[]; period?: { from: string; to: string } };
export type DecisionInput =
  | { action: 'approve'; note?: string; edits?: DecisionEdits }
  | { action: 'study'; note?: string }
  | { action: 'defer'; reason: DecisionReason; until: string; note?: string }
  | { action: 'dismiss'; reason: DecisionReason; note?: string }
  | { action: 'reopen'; note?: string };

const TARGET: Record<DecisionInput['action'], OpportunityStatus> = { approve: 'accepted', study: 'studying', defer: 'deferred', dismiss: 'dismissed', reopen: 'proposed' };
const FROM: Record<DecisionInput['action'], OpportunityStatus[]> = {
  approve: ['detected', 'assessed', 'proposed', 'studying', 'deferred'],
  study: ['detected', 'assessed', 'proposed'],
  defer: ['detected', 'assessed', 'proposed', 'studying'],
  dismiss: ['detected', 'assessed', 'proposed', 'studying', 'deferred', 'accepted'],
  reopen: ['deferred', 'dismissed'],
};

export class DecisionError extends Error { constructor(readonly code: string) { super(code); } }

export async function decide(trx: Tx, businessId: string, id: string, input: DecisionInput, actorId: string | null) {
  const row = await trx.selectFrom('loom.opportunities').select(['id', 'status', 'card']).where('business_id', '=', businessId).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!row) throw new DecisionError('not_found');
  if (!FROM[input.action].includes(row.status as OpportunityStatus)) throw new DecisionError('invalid_transition');
  const to = TARGET[input.action];
  const reason = 'reason' in input ? input.reason : null;
  await trx.updateTable('loom.opportunities').set({
    status: to, decided_at: new Date(), decided_by: actorId, decision_reason: reason, decision_note: input.note ?? null,
    deferred_until: input.action === 'defer' ? input.until : null,
  }).where('id', '=', id).execute();
  await recordEvent(trx, businessId, id, {
    event: 'decided', from: row.status, to, reason, note: input.note ?? null, actor: actorId,
    // Rejections for capacity, budget or timing are not failures of the marketing idea.
    counts_as_idea_failure: input.action === 'dismiss' ? !NON_IDEA_REASONS.includes(input.reason) : null,
    data: input.action === 'defer' ? { until: input.until } : {},
  });
  // §10.1 ladder: the decision as its own stage (edit + approve keeps the edits).
  const edits = input.action === 'approve' && input.edits && Object.keys(input.edits).length ? input.edits : null;
  let inferred: string | null = null;
  if (reason === 'brand_fit' && input.action === 'dismiss') inferred = await inferBrandFit(trx, businessId, id, row.card as CardContent, actorId);
  await recordLadder(trx, businessId, {
    opportunity_id: id, stage: 'decided', action: edits ? 'edit_approve' : input.action, reason, note: input.note ?? null, actor: actorId,
    counts_as_idea_failure: countsAsIdeaFailure(input.action, reason),
    data: { from: row.status, to, ...(input.action === 'defer' ? { until: input.until } : {}), ...(edits ? { edits } : {}), ...(inferred ? { inferred_fact: inferred } : {}) },
  });
  return { id, status: to };
}

export async function markConverted(trx: Tx, businessId: string, id: string, conversion: { target: string; ref_id: string }, actorId: string | null) {
  const row = await trx.selectFrom('loom.opportunities').select(['status', 'conversion']).where('business_id', '=', businessId).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!row) throw new DecisionError('not_found');
  if (!['accepted', 'converted', 'proposed', 'studying'].includes(row.status)) throw new DecisionError('invalid_transition');
  const list = [...(((row.conversion as { items?: unknown[] } | null)?.items) ?? []), { ...conversion, at: new Date().toISOString() }];
  await trx.updateTable('loom.opportunities').set({ status: 'converted', conversion: JSON.stringify({ items: list }), decided_at: new Date(), decided_by: actorId }).where('id', '=', id).execute();
  await recordEvent(trx, businessId, id, { event: 'converted', from: row.status, to: 'converted', actor: actorId, data: conversion });
}
