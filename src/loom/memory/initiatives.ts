import type { Tx } from '../db';
import type { CardContent, OpportunityCategory } from '../contracts/opportunity';
import type { DecisionEdits } from '../opportunities/store';
import { recordEvent } from '../opportunities/store';
import { recordLadder } from './ladder';

/**
 * Initiative record (§10.2): an opportunity converted into an artifact of the
 * host (a plan action, a campaign draft or a price proposal). The baseline
 * (metrics known at conversion + data_version) and the original proposal (the
 * card as proposed) are frozen by a database trigger; the owner's edits are a
 * diff, the approved version is the card with the edits applied.
 */
export const ARTIFACT_KINDS = ['plan_action', 'campaign_draft', 'price_proposal'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const MEASUREMENT_QUALITIES = ['experimental', 'quasi', 'observational', 'insufficient'] as const;
export type MeasurementQuality = (typeof MEASUREMENT_QUALITIES)[number];
export const INITIATIVE_STATUSES = ['scheduled', 'executing', 'completed', 'measured', 'closed', 'cancelled'] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

/** Outcome metrics per goal (§10.3). Guardrails are measured for every initiative. */
export const GOAL_METRICS = ['completed_bookings', 'contribution_margin', 'cac', 'repeat', 'reactivation', 'quiet_period_fill', 'cross_sell'] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
export const GUARDRAILS = ['cancellations', 'refunds', 'occupancy_overload', 'rating'] as const;

const BY_CATEGORY: Record<OpportunityCategory, GoalMetric[]> = {
  quiet_capacity: ['quiet_period_fill', 'completed_bookings'],
  high_satisfaction_low_demand: ['completed_bookings', 'contribution_margin'],
  lapsed_cohort: ['reactivation', 'repeat', 'completed_bookings'],
  unserved_demand: ['completed_bookings', 'contribution_margin'],
  conversion_friction: ['completed_bookings', 'cac'],
  cross_sell_affinity: ['cross_sell', 'completed_bookings'],
  slow_mover_bundle: ['cross_sell', 'contribution_margin'],
  margin_leak: ['contribution_margin'],
  missing_cost_blocker: ['contribution_margin'],
  offering_presentation: ['completed_bookings', 'cac'],
  loyalty_over_discount: ['repeat', 'contribution_margin'],
  capacity_prerequisite: ['completed_bookings'],
  campaign_learning: ['completed_bookings', 'contribution_margin'],
};
export const goalMetricsFor = (category: OpportunityCategory): GoalMetric[] => BY_CATEGORY[category] ?? ['completed_bookings'];

/** Campaign drafts are partitionable (randomised holdout); plan actions and price changes are not. */
export function designFor(kind: ArtifactKind, card: CardContent): 'holdout' | 'pre_post_with_control' | 'observational' {
  if (kind === 'campaign_draft') return 'holdout';
  return card.measurement_design === 'observational' ? 'observational' : 'pre_post_with_control';
}

export function applyEdits(card: CardContent, edits: DecisionEdits | null): { approved: CardContent; diff: Array<{ path: string; from: unknown; to: unknown }> } {
  if (!edits) return { approved: card, diff: [] };
  const approved: CardContent = structuredClone(card);
  const diff: Array<{ path: string; from: unknown; to: unknown }> = [];
  if (edits.description !== undefined) {
    diff.push({ path: 'recommended_action.description', from: card.recommended_action.description, to: { ar: edits.description, en: edits.description } });
    approved.recommended_action.description = { ar: edits.description, en: edits.description };
  }
  if (edits.channel) { diff.push({ path: 'channel', from: card.channel, to: edits.channel }); approved.channel = edits.channel as CardContent['channel']; }
  if (edits.period) { diff.push({ path: 'period', from: card.period, to: edits.period }); approved.period = edits.period; }
  return { approved, diff };
}

type OppRow = { id: string; card: unknown; subject: unknown; category: string; last_analysis_id: string | null; status: string };

async function baselineFor(trx: Tx, businessId: string, o: OppRow, offeringIds: string[]) {
  const analysis = o.last_analysis_id
    ? await trx.selectFrom('loom.analyses').select(['id', 'data_version', 'finished_at', 'period_from', 'period_to']).where('business_id', '=', businessId).where('id', '=', o.last_analysis_id).executeTakeFirst()
    : undefined;
  const card = o.card as CardContent;
  const grains = ['business', ...offeringIds.map((id) => `offering:${id}`)];
  const keys = new Set(['sales.completed_count', 'sales.completed_net', 'econ.unit_contribution_margin', 'quality.cancel_customer_rate', 'quality.rating_avg', 'capacity.occupancy', 'customers.repeat_rate', 'customers.lapsed', ...card.success_metrics.map((m) => m.metric_key)]);
  const values = analysis
    ? await trx.selectFrom('loom.metric_values').select(['metric_key', 'metric_version', 'grain_ref', 'value', 'n', 'status']).where('business_id', '=', businessId)
      .where('analysis_id', '=', analysis.id).where('metric_key', 'in', [...keys]).where('grain_ref', 'in', grains).execute()
    : [];
  return {
    analysis_id: analysis?.id ?? null, data_version: analysis?.data_version ?? null,
    snapshot: {
      captured_at: new Date().toISOString(), analysis_finished_at: analysis?.finished_at?.toISOString() ?? null,
      period: analysis ? { from: analysis.period_from, to: analysis.period_to } : null,
      success_metrics: card.success_metrics,
      metrics: values.map((v) => ({ key: v.metric_key, version: v.metric_version, grain_ref: v.grain_ref, value: v.value, n: v.n, status: v.status })),
    },
  };
}

/** Creates the initiative for a conversion (idempotent per opportunity + artifact) and records the `scheduled` stage. */
export async function createInitiative(trx: Tx, businessId: string, input: { opportunity_id: string; target: ArtifactKind; ref_id: string; actor: string | null }) {
  const o = await trx.selectFrom('loom.opportunities').select(['id', 'card', 'subject', 'category', 'last_analysis_id', 'status']).where('business_id', '=', businessId).where('id', '=', input.opportunity_id).executeTakeFirstOrThrow();
  const existing = await trx.selectFrom('loom.initiatives').select(['id']).where('business_id', '=', businessId).where('opportunity_id', '=', o.id)
    .where('artifact_kind', '=', input.target).where('artifact_ref', '=', input.ref_id).executeTakeFirst();
  if (existing) return { id: existing.id, created: false };
  const card = o.card as CardContent;
  const offeringIds = ((o.subject as { offering_ids?: string[] }).offering_ids ?? []).filter((x) => /^[0-9a-f-]{36}$/.test(x));
  const lastEdit = await trx.selectFrom('loom.decision_history').select(['data']).where('business_id', '=', businessId).where('opportunity_id', '=', o.id)
    .where('stage', '=', 'decided').where('action', '=', 'edit_approve').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  const edits = ((lastEdit?.data as { edits?: DecisionEdits } | undefined)?.edits) ?? null;
  const { approved, diff } = applyEdits(card, edits);
  const base = await baselineFor(trx, businessId, o, offeringIds);
  const row = await trx.insertInto('loom.initiatives').values({
    business_id: businessId, opportunity_id: o.id, artifact_kind: input.target, artifact_ref: input.ref_id, category: o.category, offering_ids: offeringIds,
    goal_metrics: goalMetricsFor(o.category as OpportunityCategory), window_from: approved.period.from, window_to: approved.period.to,
    baseline: JSON.stringify(base.snapshot), baseline_data_version: base.data_version, baseline_analysis_id: base.analysis_id,
    original_proposal: JSON.stringify(card), user_edits: JSON.stringify(diff), approved_version: JSON.stringify(approved),
    measurement_design: designFor(input.target, card), created_by: input.actor,
  }).onConflict((oc) => oc.columns(['business_id', 'opportunity_id', 'artifact_kind', 'artifact_ref']).doNothing()).returning('id').executeTakeFirst();
  if (!row) return { id: (await trx.selectFrom('loom.initiatives').select('id').where('business_id', '=', businessId).where('opportunity_id', '=', o.id).where('artifact_kind', '=', input.target).where('artifact_ref', '=', input.ref_id).executeTakeFirstOrThrow()).id, created: false };
  await recordLadder(trx, businessId, {
    opportunity_id: o.id, initiative_id: row.id, stage: 'scheduled', action: input.target, actor: input.actor,
    data: { ref_id: input.ref_id, window: approved.period, edited: diff.length > 0 },
  });
  return { id: row.id, created: true };
}

export type ExecutionInput = {
  source: 'connector' | 'manual'; executed_from: string; executed_to: string; audience_size?: number | null; channel?: string | null;
  actual_cost_minor?: number | null; note?: string | null; data?: Record<string, unknown>; actor?: string | null;
};

/** Records what was actually executed and moves the initiative (and its opportunity) to executing / executed. */
export async function recordExecution(trx: Tx, businessId: string, initiativeId: string, e: ExecutionInput) {
  const init = await trx.selectFrom('loom.initiatives').select(['id', 'status', 'opportunity_id']).where('business_id', '=', businessId).where('id', '=', initiativeId).forUpdate().executeTakeFirst();
  if (!init) return null;
  if (['cancelled', 'closed'].includes(init.status)) return null;
  const ex = await trx.insertInto('loom.initiative_executions').values({
    business_id: businessId, initiative_id: initiativeId, source: e.source, executed_from: e.executed_from, executed_to: e.executed_to,
    audience_size: e.audience_size ?? null, channel: e.channel ?? null, actual_cost_minor: e.actual_cost_minor ?? null, note: e.note ?? null,
    data: JSON.stringify(e.data ?? {}), actor_id: e.actor ?? null,
  }).onConflict((oc) => oc.column('initiative_id').where('source', '=', 'connector').doNothing()).returning('id').executeTakeFirst();
  if (!ex) return null;
  const summary = { source: e.source, from: e.executed_from, to: e.executed_to, audience_size: e.audience_size ?? null, channel: e.channel ?? null, actual_cost_minor: e.actual_cost_minor ?? null, note: e.note ?? null };
  await trx.updateTable('loom.initiatives').set({ execution: JSON.stringify(summary), status: init.status === 'scheduled' ? 'executing' : init.status }).where('id', '=', initiativeId).execute();
  await recordLadder(trx, businessId, { opportunity_id: init.opportunity_id, initiative_id: initiativeId, stage: 'executed', action: e.source, actor: e.actor ?? null, data: summary });
  const opp = await trx.selectFrom('loom.opportunities').select(['status']).where('id', '=', init.opportunity_id).executeTakeFirstOrThrow();
  if (['accepted', 'converted'].includes(opp.status)) {
    await trx.updateTable('loom.opportunities').set({ status: 'executed' }).where('id', '=', init.opportunity_id).execute();
    await recordEvent(trx, businessId, init.opportunity_id, { event: 'executed', from: opp.status, to: 'executed', actor: e.actor ?? null, data: { initiative_id: initiativeId, source: e.source } });
  }
  return ex.id;
}
