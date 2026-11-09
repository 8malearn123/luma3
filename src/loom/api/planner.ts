import { z } from 'zod';
import { audit, Errors, withTenant, type AuditActor } from '../db';
import { loomHost, type HostPlanRef } from '../contracts/host';
import type { CardContent } from '../contracts/opportunity';
import type { PlanKind } from '../contracts/plan';
import { knowledgeTitles, listKnowledgeUnits } from '../knowledge/store';
import { metricDefinition } from '../metrics/registry';
import '../metrics/v1';
import { renderCard } from '../opportunities/render';
import { BASELINE_METRICS } from '../planner/context';
import { AI_REASON_NOTE } from '../planner/build';
import { requestPlan } from '../planner/run';
import { rowToAction } from '../planner/revision';
import { loadFacts, setupStatus } from '../profile/facts';
import { render, type Localized, type LoomLocale } from '../util/text';
import { addDays } from '../util/time';
import { getDataQuality } from './service';

/**
 * Loom API v1 — phase 3 (planner, plans, home page, notes, knowledge).
 * Host-agnostic like ./service.ts; the host routes enforce auth, capability
 * and plan feature, and register the host ports (planner-port.ts).
 */
type Ctx = { businessId: string; actor: AuditActor; locale: LoomLocale };
type ViewCtx = Pick<Ctx, 'businessId' | 'locale'>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const planRequestInput = z.object({ kind: z.enum(['monthly', 'weekly']), period_start: isoDate.optional(), mode: z.enum(['auto', 'rules']).optional() }).strict();
export const commentInput = z.object({ body: z.string().trim().min(1).max(2000) }).strict();

export async function startPlan(c: Ctx, input: z.infer<typeof planRequestInput>) {
  const r = await requestPlan(c.businessId, { kind: input.kind, periodStart: input.period_start ?? null, mode: input.mode ?? 'auto', trigger: 'manual', requestedBy: c.actor.userId });
  await withTenant(c.businessId, (trx) => audit(trx, c.actor, 'loom.plan_requested', { tenantId: c.businessId, targetType: 'loom_planner_run', targetId: r.run.id, data: { kind: input.kind, mode: input.mode ?? 'auto', created: r.created } }));
  return { job_id: r.run.id, status: r.run.status, created: r.created };
}

const runView = (r: { id: string; kind: string; status: string; source: string | null; ai_reason: string | null; plan_id: string | null; plan_version_id: string | null; period_from: string | null; period_to: string | null; reason: unknown; error_code: string | null; created_at: Date; finished_at: Date | null; model: string | null; prompt_version: string | null }, locale: LoomLocale) => ({
  id: r.id, kind: r.kind, status: r.status, source: r.source, ai_reason: r.ai_reason, note: r.ai_reason && AI_REASON_NOTE[r.ai_reason] ? render(AI_REASON_NOTE[r.ai_reason], locale) : null,
  plan_id: r.plan_id, plan_version_id: r.plan_version_id, period: r.period_from ? { from: r.period_from, to: r.period_to } : null,
  reason: r.reason ? render(r.reason as Localized, locale) : null, error_code: r.error_code, created_at: r.created_at, finished_at: r.finished_at, model: r.model, prompt_version: r.prompt_version,
});

export async function listPlannerRuns(c: ViewCtx) {
  return withTenant(c.businessId, async (trx) => (await trx.selectFrom('loom.planner_runs').selectAll().where('business_id', '=', c.businessId).orderBy('created_at', 'desc').limit(20).execute()).map((r) => runView(r, c.locale)));
}

export async function getPlannerRun(c: ViewCtx, id: string) {
  const r = await withTenant(c.businessId, (trx) => trx.selectFrom('loom.planner_runs').selectAll().where('business_id', '=', c.businessId).where('id', '=', id).executeTakeFirst());
  if (!r) throw Errors.notFound('planner_run');
  return { ...runView(r, c.locale), validation: r.validation };
}

function actionView(a: ReturnType<typeof rowToAction> & { id: string }, locale: LoomLocale) {
  const r = (t: Localized | null | undefined) => render(t ?? null, locale);
  return {
    id: a.id, ref: a.ref, seq: a.seq, opportunity_id: a.opportunity_id, role: a.role, action_kind: a.action_kind, intervention_id: a.intervention_id,
    title: r(a.title), description: r(a.description), content_idea: a.content_idea ? r(a.content_idea) : null,
    audience: { ...a.audience, label: r(a.audience.label) }, channels: a.channels, schedule: a.schedule, owner: r(a.owner), budget: a.budget,
    operational: {
      capacity: { ...a.operational.capacity, note: r(a.operational.capacity.note) },
      inventory: { ...a.operational.inventory, note: a.operational.inventory.note ? r(a.operational.inventory.note) : null },
      requirements: a.operational.requirements.map(r),
    },
    highlighted: a.highlighted.map((h) => ({ ...h, name: r(h.name) })),
    success_metrics: a.success_metrics.map((m) => ({ ...m, label: r(metricDefinition(m.metric_key)?.label ?? null) || m.metric_key })),
    evidence_refs: a.evidence_refs, knowledge: knowledgeTitles(a.knowledge_refs).map((k) => ({ ref: k.ref, title: r(k.title) })),
    revision_note: a.revision_note ? r(a.revision_note) : null,
  };
}

async function actionsOf(businessId: string, versionId: string) {
  return withTenant(businessId, async (trx) => (await trx.selectFrom('loom.plan_actions').selectAll().where('business_id', '=', businessId).where('plan_version_id', '=', versionId).orderBy('seq').execute())
    .map((row) => ({ ...rowToAction(row as never), id: row.id })));
}

/** GET /loom/plans/{id}/actions[?version_id=] — the structured actions of a plan version (current by default). */
export async function getPlanActions(c: ViewCtx, planId: string, versionId?: string | null) {
  const plan = await loomHost().plans.get(c.businessId, planId);
  if (!plan) throw Errors.notFound('plan');
  const v = versionId ?? plan.current_version_id;
  if (!v) return { plan: planView(plan), version_id: null, actions: [], run: null };
  const actions = await actionsOf(c.businessId, v);
  const run = await withTenant(c.businessId, (trx) => trx.selectFrom('loom.planner_runs').selectAll().where('business_id', '=', c.businessId).where('plan_version_id', '=', v).executeTakeFirst());
  const draft = (run?.result as { draft?: { notes?: Localized[]; budget?: unknown; limitations?: Localized[] } } | undefined)?.draft;
  return {
    plan: planView(plan), version_id: v, actions: actions.map((a) => actionView(a, c.locale)),
    run: run ? { ...runView(run, c.locale), notes: (draft?.notes ?? []).map((n) => render(n, c.locale)), budget: draft?.budget ?? null } : null,
  };
}

const planView = (p: HostPlanRef) => ({ id: p.plan_id, kind: p.kind, title: p.title, status: p.status, period: p.period, current_version: p.current_version, has_unapproved_changes: p.has_unapproved_changes, change_note: p.current_change_note, source: p.current_source });

// ── Notes on opportunities ──────────────────────────────────────────────────
export async function listComments(c: ViewCtx, opportunityId: string) {
  return withTenant(c.businessId, async (trx) => {
    const o = await trx.selectFrom('loom.opportunities').select('id').where('business_id', '=', c.businessId).where('id', '=', opportunityId).executeTakeFirst();
    if (!o) throw Errors.notFound('opportunity');
    return trx.selectFrom('loom.opportunity_comments').select(['id', 'body', 'author_id', 'created_at']).where('business_id', '=', c.businessId).where('opportunity_id', '=', opportunityId).orderBy('created_at').execute();
  });
}

export async function addComment(c: Ctx, opportunityId: string, body: string) {
  if (!c.actor.userId) throw Errors.forbidden('A signed-in user is required');
  return withTenant(c.businessId, async (trx) => {
    const o = await trx.selectFrom('loom.opportunities').select('id').where('business_id', '=', c.businessId).where('id', '=', opportunityId).executeTakeFirst();
    if (!o) throw Errors.notFound('opportunity');
    const row = await trx.insertInto('loom.opportunity_comments').values({ business_id: c.businessId, opportunity_id: opportunityId, author_id: c.actor.userId!, body }).returning(['id', 'created_at']).executeTakeFirstOrThrow();
    await audit(trx, c.actor, 'loom.opportunity_commented', { tenantId: c.businessId, targetType: 'loom_opportunity', targetId: opportunityId });
    return row;
  });
}

// ── Home page (§11.3) ───────────────────────────────────────────────────────
export async function home(c: ViewCtx, today: string) {
  const host = loomHost();
  const dq = await getDataQuality(c);
  const [monthly, weekly, revisions] = await Promise.all([
    host.plans.current(c.businessId, 'monthly', today), host.plans.current(c.businessId, 'weekly', today), host.plans.pendingRevisions(c.businessId),
  ]);
  return withTenant(c.businessId, async (trx) => {
    const analyses = await trx.selectFrom('loom.analyses').select(['id', 'status', 'mode', 'finished_at', 'created_at', 'result']).where('business_id', '=', c.businessId).orderBy('created_at', 'desc').limit(10).execute();
    const done = analyses.filter((a) => a.status === 'succeeded');
    const last = analyses[0] ?? null;
    const values = done.length ? await trx.selectFrom('loom.metric_values').select(['analysis_id', 'metric_key', 'value']).where('business_id', '=', c.businessId)
      .where('analysis_id', 'in', done.slice(0, 2).map((a) => a.id)).where('grain_ref', '=', 'business').where('metric_key', 'in', [...BASELINE_METRICS]).execute() : [];
    const tiles = done.length ? BASELINE_METRICS.map((k) => {
      const cur = values.find((v) => v.analysis_id === done[0]!.id && v.metric_key === k)?.value ?? null;
      const prev = done[1] ? values.find((v) => v.analysis_id === done[1]!.id && v.metric_key === k)?.value ?? null : null;
      const d = metricDefinition(k);
      return { key: k, label: render(d?.label ?? null, c.locale) || k, unit: d?.unit ?? 'count', value: cur, previous: prev,
        trend: cur === null || prev === null ? null : Math.abs(cur - prev) <= Math.max(1e-9, Math.abs(prev) * 0.02) ? 'flat' : cur > prev ? 'up' : 'down' };
    }) : [];

    const opps = await trx.selectFrom('loom.opportunities').selectAll().where('business_id', '=', c.businessId).where('status', 'not in', ['expired', 'superseded', 'closed']).orderBy('priority_rank', 'asc').limit(100).execute();
    const short = (o: (typeof opps)[number]) => {
      const card = renderCard(o, c.locale);
      return { id: o.id, title: card.title, why_now: card.why_now, category: card.category, status: o.status, bucket: o.display_bucket,
        checks: { capacity: card.capacity_check.status, inventory: card.inventory_check.status, margin: card.margin_check.status }, rank: card.priority.rank };
    };
    const open = ['proposed', 'studying', 'detected', 'assessed'];
    const top = opps.filter((o) => o.display_bucket === 'top' && open.includes(o.status)).slice(0, 5).map(short);
    const pendingOpps = opps.filter((o) => o.status === 'studying' || (o.status === 'proposed' && o.display_bucket === 'top')).slice(0, 8).map(short);
    const alerts = opps.filter((o) => {
      const card = o.card as CardContent;
      const active = ['accepted', 'converted', 'executed'].includes(o.status);
      return (active && (card.capacity_check.status === 'blocked' || card.inventory_check.status === 'reorder_needed')) || (o.category === 'capacity_prerequisite' && open.includes(o.status));
    }).slice(0, 5).map((o) => {
      const card = o.card as CardContent;
      return { ...short(o), kind: card.inventory_check.status === 'reorder_needed' ? 'material' : 'capacity', note: render(card.inventory_check.status === 'reorder_needed' ? card.inventory_check.note ?? null : card.capacity_check.note, c.locale) };
    });

    const revisionRuns = revisions.length ? await trx.selectFrom('loom.planner_runs').select(['plan_id', 'reason', 'created_at']).where('business_id', '=', c.businessId).where('kind', '=', 'revision')
      .where('plan_id', 'in', revisions.map((r) => r.plan_id)).orderBy('created_at', 'desc').execute() : [];
    const planRevisions = revisions.map((p) => ({ ...planView(p), reason: (() => { const r = revisionRuns.find((x) => x.plan_id === p.plan_id); return r?.reason ? render(r.reason as Localized, c.locale) : p.current_change_note; })() }));

    // This week: the weekly plan's actions, else the monthly actions scheduled in the next 7 days.
    const weekEnd = addDays(today, 6);
    const versionFor = (p: HostPlanRef | null) => p?.current_version_id ?? null;
    const weekVersion = versionFor(weekly) ?? versionFor(monthly);
    const weekRows = weekVersion ? await trx.selectFrom('loom.plan_actions').selectAll().where('business_id', '=', c.businessId).where('plan_version_id', '=', weekVersion).orderBy('seq').execute() : [];
    const thisWeek = weekRows.map((row) => ({ ...rowToAction(row as never), id: row.id }))
      .filter((a) => weekly || (a.schedule.from <= weekEnd && a.schedule.to >= today)).map((a) => actionView(a, c.locale));

    const lastRun = await trx.selectFrom('loom.planner_runs').selectAll().where('business_id', '=', c.businessId).where('kind', '!=', 'revision').orderBy('created_at', 'desc').executeTakeFirst();
    const setup = setupStatus(await loadFacts(trx, c.businessId));
    return {
      today,
      situation: {
        analysis: last ? { id: last.id, status: last.status, mode: last.mode, finished_at: last.finished_at ?? last.created_at, data_needed: ((last.result as { data_needed?: Localized[] } | null)?.data_needed ?? []).map((x) => render(x, c.locale)) } : null,
        tiles,
        quality: dq.report ? { overall: dq.report.overall, domains: Object.fromEntries(Object.entries(dq.report.domains).map(([k, v]) => [k, { level: v.level, improve: v.improve }])) } : null,
      },
      top_opportunities: top,
      plan: { monthly: monthly ? planView(monthly) : null, weekly: weekly ? planView(weekly) : null, this_week: thisWeek, last_run: lastRun ? runView(lastRun, c.locale) : null },
      pending: { opportunities: pendingOpps, plan_revisions: planRevisions },
      results: { status: 'not_available_yet' as const, items: [] as unknown[] },
      alerts,
      setup: { complete: setup.complete, missing: setup.items.filter((i) => !i.confirmed).map((i) => ({ id: i.id, label: render(i.label, c.locale) })) },
    };
  });
}

// ── Platform: knowledge library (read-only) ─────────────────────────────────
export async function platformKnowledge(locale: LoomLocale, today: string) {
  const units = await listKnowledgeUnits(today);
  return units.map((u) => ({ ...u, title_text: render(u.title as Localized, locale) }));
}
export type { PlanKind };
