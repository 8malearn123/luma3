import type { z } from 'zod';
import { audit, Errors, withTenant, type AuditActor, type Tx } from '../db';
import type { CardContent } from '../contracts/opportunity';
import { createInitiative, recordExecution, type ArtifactKind } from '../memory/initiatives';
import { currentReaction, ladderFor, recordReaction, recordView } from '../memory/ladder';
import { NOT_CAUSAL } from '../memory/measure';
import { CHANGE_RULES } from '../memory/changes';
import { render, type Localized, type LoomLocale } from '../util/text';
import type { executionInput, feedbackInput, initiativeListQuery } from './schemas';

/**
 * Loom API v1 — phase 5 (memory and measurement). Host-agnostic like
 * service.ts: { businessId, actor, locale }. Routes:
 * src/app/api/v1/t/[tenantSlug]/loom/{initiatives,results,decisions,changes}
 * and opportunities/{id}/feedback.
 */
type Ctx = { businessId: string; actor: AuditActor; locale: LoomLocale };
type ViewCtx = Pick<Ctx, 'businessId' | 'locale'> & { actor?: AuditActor };

/** Reasons after which a re-offered opportunity shows «عادت للظهور لأن القيد زال». */
export const CONSTRAINT_CLEARED = ['capacity_available', 'inventory_available', 'budget_available', 'timing_elapsed'] as const;

/** Latest `reopened` event per opportunity when its reason is a cleared constraint (and the opportunity is open again). */
export async function resurfacedMap(trx: Tx, businessId: string, ids: string[]): Promise<Map<string, { reason: string; at: Date }>> {
  const m = new Map<string, { reason: string; at: Date }>();
  if (!ids.length) return m;
  const rows = await trx.selectFrom('loom.opportunity_events').select(['opportunity_id', 'event', 'reason', 'created_at']).where('business_id', '=', businessId)
    .where('opportunity_id', 'in', ids).where('event', 'in', ['reopened', 'decided', 'converted']).orderBy('created_at').execute();
  for (const r of rows) {
    if (r.event === 'reopened' && (CONSTRAINT_CLEARED as readonly string[]).includes(r.reason ?? '')) m.set(r.opportunity_id, { reason: r.reason!, at: r.created_at });
    else m.delete(r.opportunity_id);
  }
  return m;
}

/** Called by the conversion endpoint after the host's ActionPort ran: the initiative record + `scheduled` stage. */
export async function createInitiativeFor(trx: Tx, businessId: string, opportunityId: string, result: { target: string; ref_id: string }, actorId: string | null) {
  if (!['plan_action', 'campaign_draft', 'price_proposal'].includes(result.target)) return null;
  return createInitiative(trx, businessId, { opportunity_id: opportunityId, target: result.target as ArtifactKind, ref_id: result.ref_id, actor: actorId });
}

export async function recordFeedback(c: Ctx, opportunityId: string, input: z.infer<typeof feedbackInput>) {
  return withTenant(c.businessId, async (trx) => {
    const o = await trx.selectFrom('loom.opportunities').select('id').where('business_id', '=', c.businessId).where('id', '=', opportunityId).executeTakeFirst();
    if (!o) throw Errors.notFound('opportunity');
    if (input.kind === 'viewed') return { recorded: await recordView(trx, c.businessId, opportunityId, c.actor.userId), reaction: await currentReaction(trx, c.businessId, opportunityId, c.actor.userId) };
    await recordReaction(trx, c.businessId, opportunityId, c.actor.userId, input.reaction);
    return { recorded: true, reaction: input.reaction };
  });
}

const renderLadder = (rows: Awaited<ReturnType<typeof ladderFor>>) => rows.map((r) => ({
  stage: r.stage, action: r.action, reason: r.reason, note: r.note, counts_as_idea_failure: r.counts_as_idea_failure, data: r.data,
  opportunity_id: r.opportunity_id, initiative_id: r.initiative_id, at: r.created_at,
}));

/** Ladder + the caller's reaction + resurfacing for the opportunity detail. */
export async function opportunityMemory(trx: Tx, businessId: string, opportunityId: string, actorId: string | null) {
  const ladder = renderLadder(await ladderFor(trx, businessId, { opportunity_id: opportunityId }));
  const initiatives = await trx.selectFrom('loom.initiatives').select(['id', 'status', 'artifact_kind', 'measurement_quality']).where('business_id', '=', businessId).where('opportunity_id', '=', opportunityId).execute();
  return { ladder, reaction: await currentReaction(trx, businessId, opportunityId, actorId), initiatives };
}

type InitRow = {
  id: string; opportunity_id: string; artifact_kind: string; artifact_ref: string; status: string; category: string; offering_ids: string[]; goal_metrics: string[];
  window_from: string; window_to: string; baseline: unknown; baseline_data_version: string | null; original_proposal: unknown; user_edits: unknown; approved_version: unknown;
  execution: unknown; results: unknown; external_factors: unknown; measurement_design: string; measurement_quality: string | null; learnings: unknown;
  completed_at: Date | null; measured_at: Date | null; created_at: Date;
};

function initiativeView(i: InitRow, locale: LoomLocale, full = false) {
  const r = (t: Localized | null | undefined) => render(t, locale);
  const card = i.original_proposal as CardContent;
  const approved = i.approved_version as CardContent;
  const results = i.results as null | {
    outcome_id: string; design: string; quality: string; causal: boolean; periods: unknown;
    primary: Array<{ key: string; label: Localized; unit: string; target: unknown; control: unknown; change: number | null; estimate: number | null }>;
    guardrails: Array<{ key: string; label: Localized; pre: number | null; post: number | null; breached: boolean }>;
    attributed: unknown; incremental: unknown; limitations: Localized[];
  };
  return {
    id: i.id, opportunity_id: i.opportunity_id, title: r(approved.title ?? card.title), category: i.category, status: i.status,
    artifact: { kind: i.artifact_kind, ref: i.artifact_ref },
    window: { from: i.window_from, to: i.window_to }, offering_ids: i.offering_ids, goal_metrics: i.goal_metrics,
    action: { kind: approved.recommended_action.kind, description: r(approved.recommended_action.description) }, channel: approved.channel,
    execution: i.execution,
    measurement: {
      design: i.measurement_design, quality: i.measurement_quality,
      causal: results?.causal ?? false,
      // Anything short of a randomised holdout is a limited signal, not a causal relationship.
      note: results && !results.causal ? r(NOT_CAUSAL) : null,
    },
    results: results ? {
      outcome_id: results.outcome_id, periods: results.periods,
      primary: results.primary.map((m) => ({ ...m, label: r(m.label) })),
      guardrails: results.guardrails.map((g) => ({ ...g, label: r(g.label) })),
      attributed: results.attributed, incremental: results.incremental, limitations: results.limitations.map(r),
    } : null,
    external_factors: (i.external_factors as Array<{ type: string; label: Localized; at: string | null }>).map((f) => ({ type: f.type, at: f.at, label: r(f.label) })),
    learnings: (i.learnings as Localized[]).map(r),
    edited: (i.user_edits as unknown[]).length > 0,
    completed_at: i.completed_at, measured_at: i.measured_at, created_at: i.created_at,
    ...(full ? {
      baseline: { data_version: i.baseline_data_version, ...(i.baseline as Record<string, unknown>) },
      user_edits: i.user_edits,
      original_proposal: { title: r(card.title), action: r(card.recommended_action.description), period: card.period, channel: card.channel, measurement_design: card.measurement_design },
    } : {}),
  };
}

export async function listInitiatives(c: ViewCtx, q: z.infer<typeof initiativeListQuery>) {
  return withTenant(c.businessId, async (trx) => {
    let qb = trx.selectFrom('loom.initiatives').selectAll().where('business_id', '=', c.businessId);
    if (q.status) qb = qb.where('status', '=', q.status);
    const rows = await qb.orderBy('created_at', 'desc').limit(100).execute();
    return rows.map((i) => initiativeView(i as unknown as InitRow, c.locale));
  });
}

async function loadInitiative(trx: Tx, businessId: string, id: string) {
  const i = await trx.selectFrom('loom.initiatives').selectAll().where('business_id', '=', businessId).where('id', '=', id).executeTakeFirst();
  if (!i) throw Errors.notFound('initiative');
  return i as unknown as InitRow;
}

export async function getInitiative(c: ViewCtx, id: string) {
  return withTenant(c.businessId, async (trx) => {
    const i = await loadInitiative(trx, c.businessId, id);
    const executions = await trx.selectFrom('loom.initiative_executions').select(['id', 'source', 'executed_from', 'executed_to', 'audience_size', 'channel', 'actual_cost_minor', 'note', 'created_at'])
      .where('business_id', '=', c.businessId).where('initiative_id', '=', id).orderBy('created_at').execute();
    const ladder = renderLadder(await ladderFor(trx, c.businessId, { opportunity_id: i.opportunity_id, initiative_id: id }));
    return { ...initiativeView(i, c.locale, true), executions, ladder };
  });
}

export async function getOutcome(c: ViewCtx, id: string) {
  return withTenant(c.businessId, async (trx) => {
    const i = await loadInitiative(trx, c.businessId, id);
    const o = await trx.selectFrom('loom.outcomes').selectAll().where('business_id', '=', c.businessId).where('initiative_id', '=', id).orderBy('created_at', 'desc').executeTakeFirst();
    if (!o) return { initiative_id: id, status: i.status, outcome: null };
    const r = (t: Localized) => render(t, c.locale);
    return {
      initiative_id: id, status: i.status,
      outcome: {
        id: o.id, window: { from: o.window_from, to: o.window_to }, design: o.measurement_design, quality: o.measurement_quality, causal: o.causal,
        note: o.causal ? null : r(NOT_CAUSAL),
        primary: (o.primary_metrics as Array<{ label: Localized }>).map((m) => ({ ...m, label: r(m.label) })),
        guardrails: (o.guardrails as Array<{ label: Localized }>).map((g) => ({ ...g, label: r(g.label) })),
        attributed: o.attributed, incremental: o.incremental,
        disclosure: { attributed_is_not_incremental: true, min_group_for_incremental: 30 },
        external_factors: (o.external_factors as Array<{ type: string; label: Localized; at: string | null }>).map((f) => ({ type: f.type, at: f.at, label: r(f.label) })),
        limitations: (o.limitations as Localized[]).map(r), learnings: (o.learnings as Localized[]).map(r), data_version: o.data_version, measured_at: o.created_at,
      },
    };
  });
}

export async function addExecution(c: Ctx, id: string, input: z.infer<typeof executionInput>) {
  await withTenant(c.businessId, async (trx) => {
    const i = await loadInitiative(trx, c.businessId, id);
    if (['cancelled', 'closed', 'measured'].includes(i.status)) throw Errors.conflict('invalid_transition', 'This initiative can no longer record an execution');
    const ex = await recordExecution(trx, c.businessId, id, { source: 'manual', ...input, actor: c.actor.userId });
    if (!ex) throw Errors.conflict('invalid_transition', 'This initiative can no longer record an execution');
    // The window follows what was actually executed.
    await trx.updateTable('loom.initiatives').set({ window_from: input.executed_from, window_to: input.executed_to }).where('id', '=', id).execute();
    await audit(trx, c.actor, 'loom.initiative_executed', { tenantId: c.businessId, targetType: 'loom_initiative', targetId: id, data: { from: input.executed_from, to: input.executed_to, cost: input.actual_cost_minor ?? null } });
  });
  return getInitiative(c, id);
}

/**
 * Home embed (§11.3 «نتائج المبادرات» + «تنبيهات جوهرية»): the latest measured
 * results with their quality, counts per status, and processed change signals
 * that re-checked an opportunity or proposed a plan revision.
 */
export async function resultsSummary(c: ViewCtx) {
  return withTenant(c.businessId, async (trx) => {
    const rows = await trx.selectFrom('loom.initiatives').selectAll().where('business_id', '=', c.businessId).orderBy('updated_at', 'desc').limit(200).execute();
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const latest = rows.filter((r) => r.status === 'measured').sort((a, b) => (b.measured_at?.getTime() ?? 0) - (a.measured_at?.getTime() ?? 0)).slice(0, 5)
      .map((i) => initiativeView(i as unknown as InitRow, c.locale));
    const alerts = await changeList(trx, c.businessId, c.locale, 5, true);
    return { counts, latest, alerts };
  });
}

async function changeList(trx: Tx, businessId: string, locale: LoomLocale, limit: number, onlyImpact: boolean) {
  let q = trx.selectFrom('loom.change_signals').select(['id', 'type', 'scope', 'status', 'occurrences', 'suppressed', 'magnitude', 'threshold', 'first_seen_at', 'processed_at', 'result'])
    .where('business_id', '=', businessId);
  if (onlyImpact) q = q.where('status', '=', 'processed');
  const rows = await q.orderBy('first_seen_at', 'desc').limit(limit).execute();
  return rows.map((s) => {
    const res = s.result as { rechecked?: unknown[]; revisions?: unknown[] };
    return { ...s, label: render(CHANGE_RULES[s.type as keyof typeof CHANGE_RULES].label, locale), rechecked: res.rechecked?.length ?? 0, revisions: res.revisions ?? [] };
  });
}

export async function listChanges(c: ViewCtx) {
  return withTenant(c.businessId, (trx) => changeList(trx, c.businessId, c.locale, 50, false));
}

export async function listDecisions(c: ViewCtx, q: { opportunity_id?: string; initiative_id?: string }) {
  return withTenant(c.businessId, async (trx) => {
    if (q.opportunity_id || q.initiative_id) return renderLadder(await ladderFor(trx, c.businessId, q));
    const rows = await trx.selectFrom('loom.decision_history').select(['id', 'opportunity_id', 'initiative_id', 'stage', 'action', 'reason', 'note', 'counts_as_idea_failure', 'data', 'actor_id', 'created_at'])
      .where('business_id', '=', c.businessId).orderBy('created_at', 'desc').limit(100).execute();
    return renderLadder(rows);
  });
}
