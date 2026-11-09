import { schedule, sql, withSystem, withTenant } from '../db';
import { loomHost, PlannerAiError, type LoomHost, type PlannerAiResult } from '../contracts/host';
import { wordingBasis } from '../opportunities/render';
import type { PlanDraft, PlanKind } from '../contracts/plan';
import { recordCitations, type CitationIn } from '../knowledge/store';
import { knowledgeRef } from '../knowledge/library';
import { L, stableHash, type Localized } from '../util/text';
import { validatePlanDraft, validatePlannerOutput, type ValidationContext, type ValidationError, type ValidationResult } from '../validator/validate';
import { AI_REASON_NOTE, buildPlanDraft, rulesHead, rulesWording, type PlanHead, type Wording } from './build';
import { loadPlanningContext, plannerInput, type PlanningContext, type PlanOpp } from './context';
import { plannerPrompt } from './prompt';
import { plannerOutput, type PlannerOutput } from './schema';
import { runTools, type ToolResult } from './tools';

/**
 * Planner run (§6.1 "drafts = planner(ranked[:k], knowledge, timing) →
 * validator"): selected opportunities → AI wording (strict JSON, optional
 * read tools, one bounded re-ask) or rules wording → deterministic plan →
 * validator → host plan version (append-only) + loom.plan_actions rows +
 * card wording + knowledge citations. AI unavailable, over budget or failing
 * ⇒ the SAME contract from rules with an honest note (T9); a failure never
 * touches existing plans.
 */
export const PLAN_JOB = 'loom.plan';
export const RULES_PLANNER_VERSION = 'loom-rules-planner@1';
type Mode = 'auto' | 'rules';

export async function requestPlan(businessId: string, opts: { kind: PlanKind; periodStart?: string | null; mode?: Mode; trigger?: 'manual' | 'schedule' | 'change' | 'seed' | 'test'; requestedBy: string | null; enqueue?: boolean }) {
  return withTenant(businessId, async (trx) => {
    const row = await trx.insertInto('loom.planner_runs').values({
      business_id: businessId, kind: opts.kind, mode: opts.mode ?? 'auto', trigger: opts.trigger ?? 'manual', requested_by: opts.requestedBy, period_from: opts.periodStart ?? null,
    }).onConflict((oc) => oc.columns(['business_id', 'kind']).where('status', 'in', ['queued', 'running']).doNothing()).returningAll().executeTakeFirst();
    if (!row) {
      const live = await trx.selectFrom('loom.planner_runs').selectAll().where('business_id', '=', businessId).where('kind', '=', opts.kind).where('status', 'in', ['queued', 'running']).executeTakeFirstOrThrow();
      return { run: live, created: false };
    }
    if (opts.enqueue !== false) await schedule(trx, PLAN_JOB, { run_id: row.id }, { tenantId: businessId, dedupeKey: `loom_plan:${row.id}`, maxAttempts: 2 });
    return { run: row, created: true };
  });
}

/** Synchronous generation (tests, seed, CLI). Returns null when another run of this kind is live. */
export async function generatePlanNow(businessId: string, opts: { kind: PlanKind; periodStart?: string | null; mode?: Mode; requestedBy?: string | null; now?: Date; trigger?: 'seed' | 'test' | 'manual' }) {
  const { run, created } = await requestPlan(businessId, { kind: opts.kind, periodStart: opts.periodStart, mode: opts.mode, trigger: opts.trigger ?? 'test', requestedBy: opts.requestedBy ?? null, enqueue: false });
  if (!created) return null;
  return runPlannerRun(run.id, businessId, { now: opts.now });
}

export type PlannerRunResult = {
  run_id: string; status: 'succeeded' | 'insufficient_data'; source: 'ai' | 'rules' | null; ai_reason: string | null;
  plan_id: string | null; plan_version_id: string | null; version: number | null; draft: PlanDraft | null; validation: Record<string, unknown>;
};

export async function runPlannerRun(runId: string, businessId: string, opts: { now?: Date } = {}): Promise<PlannerRunResult | null> {
  const run = await withTenant(businessId, (trx) => trx.updateTable('loom.planner_runs').set({ status: 'running', started_at: new Date() })
    .where('id', '=', runId).where('status', '=', 'queued').returningAll().executeTakeFirst());
  if (!run) return null;
  if (run.kind === 'revision') throw new Error('revision runs are created by proposePlanRevision');
  try {
    return await generate(run.id, businessId, { kind: run.kind as PlanKind, periodStart: run.period_from, mode: run.mode as Mode, requestedBy: run.requested_by, now: opts.now });
  } catch (e) {
    await withTenant(businessId, (trx) => trx.updateTable('loom.planner_runs').set({ status: 'failed', error_code: 'planner_error', error_message: (e as Error).message.slice(0, 500), finished_at: new Date() }).where('id', '=', runId).execute());
    throw e;
  }
}

async function generate(runId: string, businessId: string, o: { kind: PlanKind; periodStart: string | null; mode: Mode; requestedBy: string | null; now?: Date }): Promise<PlannerRunResult> {
  const pc = await loadPlanningContext(businessId, { kind: o.kind, periodStart: o.periodStart, now: o.now });
  if ('insufficient' in pc) {
    await withTenant(businessId, (trx) => trx.updateTable('loom.planner_runs').set({ status: 'insufficient_data', error_code: pc.insufficient, finished_at: new Date() }).where('id', '=', runId).execute());
    return { run_id: runId, status: 'insufficient_data', source: null, ai_reason: pc.insufficient, plan_id: null, plan_version_id: null, version: null, draft: null, validation: {} };
  }
  const host = loomHost();
  let reason: string | null = null;
  if (o.mode === 'rules') reason = 'rules_requested';
  else if (!host.ai.available()) reason = 'ai_disconnected';
  else if (!(await host.ai.consumeBudget(businessId))) reason = 'ai_budget_exhausted';

  const wording = new Map<string, Wording>();
  let head: PlanHead = rulesHead(pc);
  let source: 'ai' | 'rules' = 'rules';
  let ai: { runId: string; model: string; provider: string } | null = null;
  const validation: Record<string, unknown> = {};
  const notes: Localized[] = [];
  if (!reason) {
    try {
      const r = await aiWording(pc, host);
      for (const [k, w] of r.wording) wording.set(k, w);
      if (r.head) head = r.head;
      source = 'ai';
      ai = r.ai;
      Object.assign(validation, { status: r.fallbacks.length || !r.head ? 'partially_rules' : 'valid', reasked: r.reasked, errors: r.errors, flags: r.flags, tool_calls: r.tools.length, rules_fallback: r.fallbacks });
      if (r.fallbacks.length || !r.head) notes.push(L('بعض الصياغات من القواعد لأن المدقّق رفض صياغة النموذج.', 'Some wording comes from rules because the validator rejected the model’s text.'));
    } catch (e) {
      reason = 'ai_failed';
      validation.ai_error = e instanceof PlannerAiError ? e.kind : 'error';
    }
  }
  if (reason) { notes.unshift(AI_REASON_NOTE[reason]!); validation.status = 'rules'; validation.ai_reason = reason; }
  for (const op of pc.opps) if (!wording.has(op.ref)) wording.set(op.ref, rulesWording(op));

  const draft = buildPlanDraft(pc, wording, head, { source, notes });
  validation.plan_errors = validatePlanDraft(draft, { prefs: { no_discounts: pc.profile.prefs.no_discounts, monthly_budget_minor: draft.budget.business_budget_minor } });
  let parent = o.kind === 'weekly' ? await host.plans.current(businessId, 'monthly', pc.period.from) : null;
  if (o.kind === 'weekly' && !parent) parent = await autoMonthly(businessId, runId, pc.period.from, o.now);
  const prompt = plannerPrompt(o.kind);
  const stored = await storeVersion(businessId, draft, {
    runId, planId: null, parentPlanId: parent?.plan_id ?? null, aiRunId: ai?.runId ?? null, createdBy: o.requestedBy, changeNote: null,
    validation: { ...validation, source, planner: source === 'ai' ? `${prompt.key}@${prompt.version}` : RULES_PLANNER_VERSION, candidates_hash: pc.candidates_hash },
    cards: { opps: pc.opps, wording, usedBy: source === 'ai' ? 'planner_ai' : 'rules', aiRunId: ai?.runId ?? null },
  });
  await withTenant(businessId, (trx) => trx.updateTable('loom.planner_runs').set({
    status: 'succeeded', finished_at: new Date(), source, ai_reason: reason, ai_run_id: ai?.runId ?? null, model: ai?.model ?? null,
    prompt_version: source === 'ai' ? `${prompt.key}@${prompt.version}` : RULES_PLANNER_VERSION, candidates_hash: pc.candidates_hash, analysis_id: pc.analysis.id,
    period_from: pc.period.from, period_to: pc.period.to, plan_id: stored.plan_id, plan_version_id: stored.version_id,
    validation: JSON.stringify(validation), result: JSON.stringify({ draft, version: stored.version, created_plan: stored.created, actions: draft.actions.length }),
  }).where('id', '=', runId).execute());
  return { run_id: runId, status: 'succeeded', source, ai_reason: reason, plan_id: stored.plan_id, plan_version_id: stored.version_id, version: stored.version, draft, validation };
}


/** A weekly plan links to the month's plan; with none, a rules-based monthly draft is created to hold it (as the legacy pipeline does). */
async function autoMonthly(businessId: string, runId: string, date: string, now?: Date) {
  const mpc = await loadPlanningContext(businessId, { kind: 'monthly', periodStart: date, now });
  if ('insufficient' in mpc) return null;
  const wording = new Map(mpc.opps.map((op) => [op.ref, rulesWording(op)]));
  const draft = buildPlanDraft(mpc, wording, rulesHead(mpc), { source: 'rules', notes: [L('أُنشئت تلقائيًا لربط الخطة الأسبوعية.', 'Created automatically to link the weekly plan.')] });
  const saved = await storeVersion(businessId, draft, { runId, planId: null, parentPlanId: null, aiRunId: null, createdBy: null, changeNote: null, validation: { status: 'rules', auto_monthly: true, planner: RULES_PLANNER_VERSION } });
  return loomHost().plans.get(businessId, saved.plan_id);
}

/** Stores a plan version through the host and its actions / citations / card wording in schema loom. */
export async function storeVersion(businessId: string, draft: PlanDraft, o: {
  runId: string; planId: string | null; parentPlanId: string | null; aiRunId: string | null; createdBy: string | null; changeNote: string | null; validation: Record<string, unknown>;
  cards?: { opps: PlanOpp[]; wording: Map<string, Wording>; usedBy: 'planner_ai' | 'rules'; aiRunId: string | null };
}) {
  const host = loomHost();
  const saved = await host.plans.saveVersion(businessId, { draft, planId: o.planId, parentPlanId: o.parentPlanId, aiRunId: o.aiRunId, validation: o.validation, changeNote: o.changeNote, createdBy: o.createdBy });
  await withTenant(businessId, async (trx) => {
    const cites: CitationIn[] = [];
    for (const a of draft.actions) {
      const row = await trx.insertInto('loom.plan_actions').values({
        business_id: businessId, plan_id: saved.plan_id, plan_version_id: saved.version_id, planner_run_id: o.runId, opportunity_id: a.opportunity_id, plan_kind: draft.kind,
        seq: a.seq, ref: a.ref, action_kind: a.action_kind, intervention_id: a.intervention_id, role: a.role, title: JSON.stringify(a.title), description: JSON.stringify(a.description),
        content_idea: a.content_idea ? JSON.stringify(a.content_idea) : null, audience: JSON.stringify(a.audience), channels: a.channels, schedule_from: a.schedule.from, schedule_to: a.schedule.to,
        owner: JSON.stringify(a.owner), budget_minor: a.budget.amount_minor, budget_basis: a.budget.basis, operational: JSON.stringify(a.operational), highlighted: JSON.stringify(a.highlighted),
        success_metrics: JSON.stringify(a.success_metrics), evidence_refs: a.evidence_refs, knowledge_refs: a.knowledge_refs, revision_note: a.revision_note ? JSON.stringify(a.revision_note) : null,
      }).returning('id').executeTakeFirstOrThrow();
      for (const k of a.knowledge_refs) cites.push({ ref: k, opportunity_id: a.opportunity_id, plan_action_id: row.id, planner_run_id: o.runId, item_ref: `plan_action:${a.ref}`, used_by: o.cards?.usedBy ?? 'rules' });
    }
    if (o.cards) {
      for (const op of o.cards.opps) {
        const w = o.cards.wording.get(op.ref);
        if (!w) continue;
        await trx.updateTable('loom.opportunities').set({ wording: JSON.stringify({
          source: w.source, title: w.title, why_now: w.why_now, action_description: w.action_description, draft_content: w.draft_content, knowledge_refs: w.knowledge_refs,
          event_ref: w.event_ref, assumptions: w.assumptions, basis: wordingBasis(op.card), planner_run_id: o.runId, ai_run_id: w.source === 'ai' ? o.cards.aiRunId : null, at: new Date().toISOString(),
        }) }).where('business_id', '=', businessId).where('id', '=', op.id).execute();
        for (const k of w.knowledge_refs) cites.push({ ref: k, opportunity_id: op.id, planner_run_id: o.runId, item_ref: `card:${op.id}`, used_by: w.source === 'ai' ? 'planner_ai' : 'rules' });
      }
    }
    await recordCitations(trx, businessId, cites);
  });
  return saved;
}

// ── AI wording ──────────────────────────────────────────────────────────────
export function validationContextOf(pc: PlanningContext, toolResults: ToolResult[] = []): ValidationContext {
  const refs = new Map<string, number | null>();
  for (const o of pc.opps) {
    for (const e of o.evidence) refs.set(e.id, e.value);
    for (const c of o.computed) refs.set(c.id, c.value);
  }
  for (const t of toolResults) refs.set(t.id, t.value);
  const computedSpend = pc.opps.reduce((s, o) => s + (o.card.estimated_cost.basis === 'computed' ? o.card.estimated_cost.amount_minor ?? 0 : 0), 0);
  return {
    today: pc.today, period: pc.period,
    items: pc.opps.map((o) => ({ ref: o.ref, opportunity_id: o.id, checks: { capacity: o.card.capacity_check.status, inventory: o.card.inventory_check.status, margin: o.card.margin_check.status }, promotional: o.promotional, free_slots: o.free_slots })),
    refs,
    prefs: {
      no_discounts: pc.profile.prefs.no_discounts, max_discount_bp: pc.profile.prefs.max_discount_bp,
      monthly_budget_minor: pc.profile.prefs.monthly_budget_minor === null ? null : pc.kind === 'weekly' ? Math.floor(pc.profile.prefs.monthly_budget_minor / 4) : pc.profile.prefs.monthly_budget_minor,
      excluded_names: pc.ds.offerings.filter((x) => pc.profile.prefs.excluded_offerings.includes(x.id)).flatMap((x) => [x.name.ar, x.name.en]).filter(Boolean),
      banned_words: pc.profile.prefs.tone?.banned_words ?? [],
    },
    computed_spend_minor: computedSpend,
    forbiddenClaims: pc.pack.validation.forbiddenClaims,
    verifiedEvents: pc.events,
    knowledgeRefs: new Set(pc.opps.flatMap((o) => o.knowledge.map((k) => knowledgeRef(k.unit)))),
  };
}

async function aiWording(pc: PlanningContext, host: LoomHost) {
  const prompt = plannerPrompt(pc.kind);
  const base = plannerInput(pc);
  const summary = { kind: pc.kind, period: pc.period, opportunities: pc.opps.length, evidence: pc.opps.reduce((s, o) => s + o.evidence.length, 0), events: pc.events.length };
  const call = (extra: Record<string, unknown>, parts: Record<string, unknown>) => host.ai.run<PlannerOutput>(pc.businessId, {
    prompt, input: { ...base, ...extra }, output: plannerOutput, inputSummary: { ...summary, ...parts },
    cacheParts: { candidates: pc.candidates_hash, analysis: pc.analysis.snapshot_hash, period: pc.period, ...parts }, maxOutputTokens: 8000,
  });
  let res: PlannerAiResult<PlannerOutput> = await call({}, { round: 0 });
  let tools: ToolResult[] = [];
  if (res.output.tool_requests.length) {
    tools = runTools(pc, res.output.tool_requests);
    res = await call({ tool_results: tools }, { round: 1, tools: stableHash(tools) });
  }
  const vctx = validationContextOf(pc, tools);
  const first = validatePlannerOutput(res.output, vctx);
  let final: ValidationResult = first;
  let reasked = false;
  const errors: ValidationError[] = [...first.errors];
  if (first.errors.length) {
    reasked = true;
    try {
      res = await call({ ...(tools.length ? { tool_results: tools } : {}), validation_errors: first.errors.slice(0, 20) }, { round: 2, errors: stableHash(first.errors) });
      const second = validatePlannerOutput(res.output, vctx);
      errors.push(...second.errors);
      final = mergeValidation(first, second);
    } catch (e) {
      if (!(e instanceof PlannerAiError)) throw e;
    }
  }
  const wording = new Map<string, Wording>();
  const fallbacks: string[] = [];
  for (const o of pc.opps) {
    const c = final.cards.get(o.ref);
    if (!c) { fallbacks.push(o.ref); continue; }
    const ini = final.initiatives.find((i) => i.opportunity_ref === o.ref);
    wording.set(o.ref, {
      title: c.title, why_now: c.why_now, action_description: c.action_description, draft_content: c.draft_content, content_idea: ini?.content_idea ?? null,
      knowledge_refs: c.knowledge_refs.length ? c.knowledge_refs : rulesWording(o).knowledge_refs, event_ref: c.event_ref ?? o.card.timing.event_ref,
      budget_minor: final.plan_ok ? ini?.budget_minor ?? null : null, assumptions: [...(final.assumptions.get(o.ref) ?? []), ...(final.assumptions.get(`plan:${o.ref}`) ?? [])], source: 'ai',
    });
  }
  const head: PlanHead | null = final.plan_ok ? { title: res.output.plan.title, goal: res.output.plan.goal, limitations: res.output.plan.limitations, source: 'ai' } : null;
  return { wording, head, fallbacks, reasked, errors, flags: final.flags, tools, ai: { runId: res.runId, model: res.model, provider: res.provider } };
}

function mergeValidation(a: ValidationResult, b: ValidationResult): ValidationResult {
  const cards = new Map(a.cards);
  for (const [k, v] of b.cards) cards.set(k, v);
  const initiatives = [...b.initiatives, ...a.initiatives.filter((x) => !b.initiatives.some((y) => y.opportunity_ref === x.opportunity_ref))];
  const assumptions = new Map(a.assumptions);
  for (const [k, v] of b.assumptions) assumptions.set(k, v);
  return { cards, initiatives, plan_ok: b.plan_ok, errors: b.errors, flags: [...a.flags, ...b.flags], assumptions };
}

/** Sweeps planner runs stuck in 'running' (worker crash) after 30 minutes. */
export async function failStuckPlannerRuns() {
  await withSystem('loom: stuck planner runs', (trx) => sql`update loom.planner_runs set status = 'failed', error_code = 'timeout', finished_at = now()
    where status = 'running' and started_at < now() - interval '30 minutes'`.execute(trx));
}
