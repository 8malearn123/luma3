import { Errors, withTenant } from '../db';
import { loomHost } from '../contracts/host';
import type { PlanAction, PlanDraft, PlanRevisionChange } from '../contracts/plan';
import { L, type Localized } from '../util/text';
import { RULES_PLANNER_VERSION, storeVersion } from './run';

/**
 * T10: a material change after approval NEVER edits the approved plan. It
 * produces a proposed revision: a NEW (unapproved) version of the same plan
 * with the reason, built from the latest version's actions. The approved
 * version stays in effect until the owner approves the revision.
 *
 * Phase 5's change aggregator calls this. Contract:
 *   proposePlanRevision(businessId, planId, reason, changes, opts?)
 *     reason   Localized (or a plain string, used for both languages)
 *     changes  PlanRevisionChange[] (pause / remove / reschedule an action,
 *              add a requirement, pause every action of an opportunity)
 *   → { status: 'proposed', plan_id, version_id, version, approved_version_id }
 *   | { status: 'skipped', reason: 'plan_closed' | 'no_effect' }
 * Throws not_found for an unknown plan and invalid('not_a_loom_plan') for a
 * plan whose latest version has no Loom actions (legacy / manual plans).
 */
export type RevisionResult =
  | { status: 'proposed'; plan_id: string; version_id: string; version: number; approved_version_id: string | null; run_id: string }
  | { status: 'skipped'; reason: 'plan_closed' | 'no_effect' };

type ActionRow = {
  id: string; opportunity_id: string | null; seq: number; ref: string; action_kind: string; intervention_id: string | null; role: string; title: unknown; description: unknown;
  content_idea: unknown; audience: unknown; channels: string[]; schedule_from: string | null; schedule_to: string | null; owner: unknown; budget_minor: number | null; budget_basis: string;
  operational: unknown; highlighted: unknown; success_metrics: unknown; evidence_refs: string[]; knowledge_refs: string[]; revision_note: unknown; planner_run_id: string | null;
};

export function rowToAction(r: ActionRow): PlanAction {
  return {
    ref: r.ref, seq: r.seq, opportunity_id: r.opportunity_id, role: r.role as PlanAction['role'], action_kind: r.action_kind as PlanAction['action_kind'], intervention_id: r.intervention_id,
    title: r.title as Localized, description: r.description as Localized, content_idea: (r.content_idea as Localized | null) ?? null, audience: r.audience as PlanAction['audience'],
    channels: r.channels as PlanAction['channels'], schedule: { from: r.schedule_from ?? '', to: r.schedule_to ?? '' }, owner: r.owner as Localized,
    budget: { amount_minor: r.budget_minor, basis: r.budget_basis as PlanAction['budget']['basis'] }, operational: r.operational as PlanAction['operational'],
    highlighted: r.highlighted as PlanAction['highlighted'], success_metrics: r.success_metrics as PlanAction['success_metrics'], evidence_refs: r.evidence_refs,
    knowledge_refs: r.knowledge_refs, revision_note: (r.revision_note as Localized | null) ?? null,
  };
}

export function applyRevision(actions: PlanAction[], changes: PlanRevisionChange[]): { actions: PlanAction[]; applied: number } {
  let out = actions.map((a) => ({ ...a, revision_note: null as Localized | null, operational: { ...a.operational, requirements: [...a.operational.requirements] } }));
  let applied = 0;
  const pause = (a: PlanAction, note: Localized) => {
    a.revision_note = note;
    a.operational.requirements.unshift(L(`متوقف مؤقتًا حتى تُحل المشكلة: ${note.ar}`, `Paused until resolved: ${note.en}`));
    applied++;
  };
  for (const c of changes) {
    if (c.kind === 'pause_opportunity') { for (const a of out) if (a.opportunity_id === c.opportunity_id) pause(a, c.note); continue; }
    const a = out.find((x) => x.ref === c.action_ref);
    if (!a) continue;
    if (c.kind === 'pause_action') pause(a, c.note);
    else if (c.kind === 'remove_action') { out = out.filter((x) => x !== a); applied++; }
    else if (c.kind === 'reschedule_action') { a.schedule = c.schedule; a.revision_note = c.note; applied++; }
    else if (c.kind === 'add_requirement') { a.operational.requirements.push(c.requirement); a.revision_note = c.note; applied++; }
  }
  return { actions: out, applied };
}

export async function proposePlanRevision(businessId: string, planId: string, reason: Localized | string, changes: PlanRevisionChange[], opts: { actorId?: string | null; trigger?: 'change' | 'manual' | 'test' } = {}): Promise<RevisionResult> {
  const host = loomHost();
  const plan = await host.plans.get(businessId, planId);
  if (!plan) throw Errors.notFound('plan');
  if (['completed', 'rejected'].includes(plan.status)) return { status: 'skipped', reason: 'plan_closed' };
  const why: Localized = typeof reason === 'string' ? { ar: reason, en: reason } : reason;
  const base = await withTenant(businessId, async (trx) => {
    const rows = plan.current_version_id ? await trx.selectFrom('loom.plan_actions').selectAll().where('business_id', '=', businessId).where('plan_version_id', '=', plan.current_version_id).orderBy('seq').execute() : [];
    const run = plan.current_version_id ? await trx.selectFrom('loom.planner_runs').select(['result']).where('business_id', '=', businessId).where('plan_version_id', '=', plan.current_version_id).executeTakeFirst() : undefined;
    return { rows, draft: (run?.result as { draft?: PlanDraft } | undefined)?.draft ?? null };
  });
  if (!base.rows.length || !base.draft) throw Errors.invalid('not_a_loom_plan', 'The plan’s latest version has no Loom actions');
  const { actions, applied } = applyRevision(base.rows.map((r) => rowToAction(r as unknown as ActionRow)), changes);
  if (!applied) return { status: 'skipped', reason: 'no_effect' };
  const draft: PlanDraft = {
    ...base.draft, actions, source: 'rules',
    notes: [L(`مقترح تعديل: ${why.ar}`, `Proposed revision: ${why.en}`), ...base.draft.notes.filter((n) => !n.en.startsWith('Proposed revision:'))],
    budget: { ...base.draft.budget, total_minor: actions.some((a) => a.budget.amount_minor !== null) ? actions.reduce((s, a) => s + (a.budget.amount_minor ?? 0), 0) : null },
  };
  const run = await withTenant(businessId, (trx) => trx.insertInto('loom.planner_runs').values({
    business_id: businessId, kind: 'revision', status: 'running', trigger: opts.trigger ?? 'change', mode: 'rules', period_from: draft.period.from, period_to: draft.period.to,
    source: 'rules', plan_id: planId, reason: JSON.stringify(why), requested_by: opts.actorId ?? null, started_at: new Date(),
  }).returning('id').executeTakeFirstOrThrow());
  const stored = await storeVersion(businessId, draft, {
    runId: run.id, planId, parentPlanId: null, aiRunId: null, createdBy: opts.actorId ?? null, changeNote: `revision: ${why.en}`.slice(0, 500),
    validation: { status: 'revision_proposed', reason: why, changes, base_version_id: plan.current_version_id, planner: RULES_PLANNER_VERSION },
  });
  await withTenant(businessId, (trx) => trx.updateTable('loom.planner_runs').set({
    status: 'succeeded', finished_at: new Date(), plan_version_id: stored.version_id, result: JSON.stringify({ draft, version: stored.version, applied, changes }),
  }).where('id', '=', run.id).execute());
  return { status: 'proposed', plan_id: planId, version_id: stored.version_id, version: stored.version, approved_version_id: plan.approved_version_id, run_id: run.id };
}
