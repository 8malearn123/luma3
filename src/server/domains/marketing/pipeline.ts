import { sql, withTenant, type Tx } from '../../db/client';
import { effectiveCapabilities, type TenantRole } from '../../auth/capabilities';
import { AiError, aiProvider, digest, runAi } from '../../infra/ai';
import { schedule } from '../../infra/outbox';
import { PermanentJobError } from '../../jobs/registry';
import { loadEntitlements } from '../../tenancy/access';
import { evaluatedTeam } from '../analytics/performance';
import { addDays, localToday, monthBounds, weekdayOf } from '../analytics/period';
import type { AI_JOB_KINDS, PlanContent } from '@/shared/schemas/marketing';
import { saveGeneratedPlan } from './plans';
import { jsonSchemaOf, registerPrompt, type PromptKind } from './prompts';
import { saveRecommendations } from './recommendations';
import { RULES_VERSION, missingText, rulesMonthlyPlan, rulesRecommendations, rulesWeeklyPlan } from './rules';
import { buildSnapshot, modelInput, type SnapshotData } from './snapshot';
import { assessTrends } from './trends';
import type { Provenance, RecDraft } from './types';
import { EMPLOYMENT_DECISION_RE, validatePlan, validateRecommendations } from './validate';

/**
 * Loom Marketing pipeline (§29):
 *  1. verify tenant, requester permission, plan feature and monthly AI budget;
 *  2. trusted metric snapshot (period, data_as_of, content hash);
 *  3. preferences, prior decisions, verified calendar and trend observations;
 *  4. provider call through runAi with a strict JSON schema (prompt_versions);
 *  5. validation of numbers, citations and constraints;
 *  6. save plan version / recommendations with provenance (ai_runs holds tokens & cost);
 *  7. a draft for the owner — nothing is published or sent.
 * Jobs are idempotent per tenant/kind/period (one live job), asynchronous, and
 * retried with backoff by the job runner. A failure never touches existing plans.
 */

export type AiJobKind = (typeof AI_JOB_KINDS)[number];
type Mode = 'auto' | 'rules';
type Outcome = { status: 'succeeded' | 'insufficient_data' | 'unavailable'; errorCode?: string | null; errorMessage?: string | null; result: Record<string, unknown> };

export const AI_JOB_KIND = 'marketing.ai_job';

export function periodFor(kind: AiJobKind, tz: string, weeklyWeekday: number, periodStart?: string, now = new Date()) {
  const today = localToday(tz, now);
  switch (kind) {
    case 'monthly_plan': { const b = monthBounds(periodStart ?? today); return { ...b, key: b.from.slice(0, 7) }; }
    case 'weekly_plan': {
      let from = periodStart ?? today;
      if (!periodStart) while (weekdayOf(from) !== weeklyWeekday) from = addDays(from, 1);
      return { from, to: addDays(from, 6), key: from };
    }
    case 'employee_insights': { const b = monthBounds(periodStart ?? today); return { from: addDays(today, -90), to: addDays(today, -1), key: b.from.slice(0, 7) }; }
    case 'recommendations': { const from = periodStart ?? today; return { from, to: addDays(from, 29), key: from }; }
    case 'trend_assessment': { const from = periodStart ?? today; return { from, to: addDays(from, 13), key: from }; }
  }
}

function periodFromKey(kind: AiJobKind, key: string) {
  if (kind === 'monthly_plan') return monthBounds(`${key}-01`);
  if (kind === 'employee_insights') return null;
  return { from: key, to: addDays(key, kind === 'weekly_plan' ? 6 : kind === 'trend_assessment' ? 13 : 29) };
}

export async function requestAiJob(tenantId: string, opts: {
  kind: AiJobKind; periodStart?: string; trigger: 'manual' | 'schedule'; requestedBy: string | null; regenerationOf?: string | null; targetPlanId?: string | null; mode?: Mode;
}) {
  return withTenant(tenantId, async (trx) => {
    const t = await trx.selectFrom('tenants').select(['timezone']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    const pref = await trx.selectFrom('marketing_preferences').select(['weekly_weekday']).where('tenant_id', '=', tenantId).executeTakeFirst();
    const p = periodFor(opts.kind, t.timezone, pref?.weekly_weekday ?? 0, opts.periodStart);
    if (opts.trigger === 'schedule') {
      const done = await trx.selectFrom('ai_jobs').selectAll().where('tenant_id', '=', tenantId).where('kind', '=', opts.kind).where('period_key', '=', p.key)
        .where('status', 'in', ['queued', 'running', 'succeeded', 'insufficient_data', 'unavailable']).orderBy('created_at', 'desc').executeTakeFirst();
      if (done) return { job: done, created: false };
    }
    const row = await trx.insertInto('ai_jobs').values({
      tenant_id: tenantId, kind: opts.kind, period_key: p.key, status: 'queued', requested_by: opts.requestedBy, trigger: opts.trigger,
      regeneration_of: opts.regenerationOf ?? null, target_plan_id: opts.targetPlanId ?? null,
    }).onConflict((oc) => oc.columns(['tenant_id', 'kind', 'period_key']).where('status', 'in', ['queued', 'running']).doNothing())
      .returningAll().executeTakeFirst();
    if (!row) {
      const live = await trx.selectFrom('ai_jobs').selectAll().where('tenant_id', '=', tenantId).where('kind', '=', opts.kind).where('period_key', '=', p.key)
        .where('status', 'in', ['queued', 'running']).executeTakeFirstOrThrow();
      return { job: live, created: false };
    }
    await schedule(trx, AI_JOB_KIND, { ai_job_id: row.id, mode: opts.mode ?? 'auto' }, { tenantId, dedupeKey: `ai_job:${row.id}`, maxAttempts: row.max_attempts });
    return { job: row, created: true };
  });
}

/** Atomically consumes one unit of limit.ai_runs_monthly for the tenant-local month. */
async function consumeAiBudget(trx: Tx, tenantId: string, limit: number | null, monthStart: string): Promise<boolean> {
  const r = await sql<{ value: number }>`
    insert into usage_counters (tenant_id, metric, period_start, value) values (${tenantId}, 'ai_runs', ${monthStart}, 1)
    on conflict (tenant_id, metric, period_start) do update set value = usage_counters.value + 1
    where ${limit === null ? sql`true` : sql`usage_counters.value < ${limit}`}
    returning value`.execute(trx);
  const v = r.rows[0]?.value;
  return v !== undefined && (limit === null || v <= limit);
}

type Ctx = { tenantId: string; tz: string; locale: 'ar' | 'en'; job: { id: string; kind: AiJobKind; period_key: string; requested_by: string | null; target_plan_id: string | null; attempts: number }; mode: Mode; attempt: number };

async function decideAi(ctx: Ctx): Promise<{ use: boolean; reason: 'rules_requested' | 'ai_disconnected' | 'ai_budget_exhausted' | null }> {
  if (ctx.mode === 'rules') return { use: false, reason: 'rules_requested' };
  if (!aiProvider()) return { use: false, reason: 'ai_disconnected' };
  const ok = await withTenant(ctx.tenantId, async (trx) => {
    const ent = await loadEntitlements(trx, ctx.tenantId);
    const f = ent.features.get('limit.ai_runs_monthly');
    if (!f || !f.enabled) return false;
    // One unit per job (retries of the same job do not consume again).
    if (ctx.attempt > 1) return true;
    return consumeAiBudget(trx, ctx.tenantId, f.limit, monthBounds(localToday(ctx.tz)).from);
  });
  return ok ? { use: true, reason: null } : { use: false, reason: 'ai_budget_exhausted' };
}

function fallbackOutcome(reason: string | null): Pick<Outcome, 'status' | 'errorCode'> {
  if (!reason || reason === 'rules_requested') return { status: 'succeeded', errorCode: null };
  return { status: 'unavailable', errorCode: reason };
}

async function callModel<T>(ctx: Ctx, kind: PromptKind, input: Record<string, unknown>, cacheParts: unknown, summary: Record<string, unknown>) {
  const p = await withTenant(ctx.tenantId, (trx) => registerPrompt(trx, kind));
  const res = await runAi({
    tenantId: ctx.tenantId, jobId: ctx.job.id,
    request: { promptKey: p.key, promptVersion: p.version, system: p.system, input, jsonSchema: jsonSchemaOf(p.output), schemaName: p.schemaName, maxOutputTokens: 6000 },
    validator: p.output as never,
    inputSummary: summary,
    // Scoped by tenant + snapshot + prompt (+ model inside runAi): never shared across businesses.
    cacheKey: digest({ tenant: ctx.tenantId, prompt: p.key, version: p.version, parts: cacheParts }),
  });
  const prov: Provenance = { source_type: 'ai', provider: res.provider, model: res.model, prompt_version: `${p.key}@${p.version}`, ai_run_id: res.runId };
  return { output: res.output as T, prov, cached: res.cached };
}

async function planJob(ctx: Ctx, kind: 'monthly_plan' | 'weekly_plan'): Promise<Outcome> {
  const period = periodFromKey(kind, ctx.job.period_key)!;
  const snap = await withTenant(ctx.tenantId, (trx) => buildSnapshot(trx, ctx.tenantId, { kind, from: period.from, to: period.to }));
  const d = snap.data;
  if (d.sufficiency.level === 'none') {
    return { status: 'insufficient_data', errorCode: 'insufficient_data', result: { snapshot_id: snap.id, missing: d.sufficiency.missing, message: d.sufficiency.missing.map((m) => missingText(ctx.locale, m)) } };
  }

  // Weekly plans link to the month's plan; create a rules-based monthly draft if there is none.
  let parent: { id: string; content: PlanContent } | null = null;
  if (kind === 'weekly_plan') {
    parent = await withTenant(ctx.tenantId, async (trx) => {
      const m = await trx.selectFrom('marketing_plans as p').innerJoin('plan_versions as v', (j) => j.on(sql<boolean>`v.id = coalesce(p.approved_version_id, p.current_version_id)`))
        .select(['p.id', 'v.content']).where('p.tenant_id', '=', ctx.tenantId).where('p.kind', '=', 'monthly').where('p.is_example', '=', false)
        .where('p.status', 'not in', ['rejected', 'completed']).where('p.period_start', '<=', period.from).where('p.period_end', '>=', period.from)
        .orderBy(sql`case p.status when 'in_progress' then 0 when 'approved' then 1 else 2 end`).orderBy('p.created_at', 'desc').executeTakeFirst();
      if (m) return { id: m.id, content: m.content as PlanContent };
      const mb = monthBounds(period.from);
      const g = rulesMonthlyPlan(d, rulesRecommendations(d), mb.from, mb.to, [ctx.locale === 'ar' ? 'أُنشئت تلقائياً لربط الخطة الأسبوعية.' : 'Created automatically to link the weekly plan.']);
      const saved = await saveGeneratedPlan(trx, ctx.tenantId, { kind: 'monthly', from: mb.from, to: mb.to, title: g.title, content: g.content, source: 'rules', snapshotId: snap.id, validation: { status: 'rules' } });
      return { id: saved.plan_id, content: g.content };
    });
  }

  const ai = await decideAi(ctx);
  let recs: RecDraft[];
  let plan: { title: string; content: PlanContent; validation: Record<string, unknown> };
  let prov: Provenance;
  let rejected: unknown[] = [];
  const aiNote = ai.reason === 'ai_disconnected' ? (ctx.locale === 'ar' ? 'الذكاء الاصطناعي غير متصل؛ هذه خطة بالقواعد.' : 'AI is not connected; this is a rules-based plan.')
    : ai.reason === 'ai_budget_exhausted' ? (ctx.locale === 'ar' ? 'انتهت حصة التحليلات الشهرية؛ هذه خطة بالقواعد.' : 'Monthly AI analyses are used up; this is a rules-based plan.') : null;
  if (ai.use) {
    const parentGoals = parent?.content.monthly_goals.length ? parent.content.monthly_goals : parent?.content.initiatives.map((i) => ({ id: i.id, title: i.title }));
    const input = { task: kind, ...modelInput(d), plan_period: period, ...(parentGoals ? { parent_monthly_goals: parentGoals } : {}) };
    const { output, prov: pv } = await callModel<{ plan: Parameters<typeof validatePlan>[1]; recommendations: Parameters<typeof validateRecommendations>[1] }>(
      ctx, kind, input, { snapshot: snap.hash, period, parent: parent?.id ?? null },
      { kind, period, snapshot_id: snap.id, metrics: Object.keys(d.metrics).length, services: d.services.length, trends: d.trends.length });
    const v = validateRecommendations(d, output.recommendations, { periodFrom: period.from, periodTo: period.to });
    recs = v.accepted; rejected = v.rejected;
    plan = validatePlan(d, output.plan, { from: period.from, to: period.to, parentGoals: kind === 'weekly_plan' ? parentGoals ?? [] : undefined });
    plan.validation = { ...plan.validation, rejected_recommendations: v.rejected };
    prov = pv;
  } else {
    recs = rulesRecommendations(d);
    const g = kind === 'monthly_plan' ? rulesMonthlyPlan(d, recs, period.from, period.to, aiNote ? [aiNote] : []) : rulesWeeklyPlan(d, parent?.content ?? null, period.from, period.to, aiNote ? [aiNote] : []);
    plan = { ...g, validation: { status: 'rules', ai_reason: ai.reason } };
    prov = { source_type: 'rules', provider: null, model: null, prompt_version: RULES_VERSION, ai_run_id: null };
  }
  const saved = await withTenant(ctx.tenantId, async (trx) => {
    const sp = await saveGeneratedPlan(trx, ctx.tenantId, {
      kind: kind === 'monthly_plan' ? 'monthly' : 'weekly', from: period.from, to: period.to, title: plan.title, content: plan.content,
      source: prov.source_type === 'ai' ? 'ai' : 'rules', parentPlanId: parent?.id ?? null, targetPlanId: ctx.job.target_plan_id,
      aiRunId: prov.ai_run_id, snapshotId: snap.id, validation: plan.validation, createdBy: ctx.job.requested_by,
    });
    const sr = await saveRecommendations(trx, ctx.tenantId, recs, prov, { snapshotId: snap.id, dataAsOf: new Date(d.data_as_of), planId: sp.plan_id });
    return { ...sp, recommendations: sr };
  });
  return {
    ...fallbackOutcome(ai.reason),
    result: { plan_id: saved.plan_id, version: saved.version, created_plan: saved.created, source: prov.source_type, ai_reason: ai.reason,
      recommendations_saved: saved.recommendations.saved.length, recommendations_kept: saved.recommendations.kept, rejected, snapshot_id: snap.id, experimental: plan.content.experimental },
  };
}

async function recommendationsJob(ctx: Ctx): Promise<Outcome> {
  const period = periodFromKey('recommendations', ctx.job.period_key)!;
  const snap = await withTenant(ctx.tenantId, (trx) => buildSnapshot(trx, ctx.tenantId, { kind: 'recommendations', from: period.from, to: period.to }));
  if (snap.data.sufficiency.level === 'none') return { status: 'insufficient_data', errorCode: 'insufficient_data', result: { snapshot_id: snap.id, missing: snap.data.sufficiency.missing } };
  const ai = await decideAi(ctx);
  let recs: RecDraft[]; let prov: Provenance; let rejected: unknown[] = [];
  if (ai.use) {
    const r = await callModel<{ recommendations: Parameters<typeof validateRecommendations>[1] }>(ctx, 'recommendations', { task: 'recommendations', ...modelInput(snap.data), plan_period: period },
      { snapshot: snap.hash, period }, { kind: 'recommendations', period, snapshot_id: snap.id });
    const v = validateRecommendations(snap.data, r.output.recommendations, { periodFrom: period.from, periodTo: period.to });
    recs = v.accepted; rejected = v.rejected; prov = r.prov;
  } else {
    recs = rulesRecommendations(snap.data);
    prov = { source_type: 'rules', provider: null, model: null, prompt_version: RULES_VERSION, ai_run_id: null };
  }
  const sr = await withTenant(ctx.tenantId, (trx) => saveRecommendations(trx, ctx.tenantId, recs, prov, { snapshotId: snap.id, dataAsOf: new Date(snap.data.data_as_of) }));
  return { ...fallbackOutcome(ai.reason), result: { source: prov.source_type, ai_reason: ai.reason, saved: sr.saved.length, kept: sr.kept, superseded: sr.superseded, rejected, snapshot_id: snap.id } };
}

async function insightsJob(ctx: Ctx): Promise<Outcome> {
  const ai = await decideAi(ctx);
  if (!ai.use) return { status: 'unavailable', errorCode: ai.reason, result: { reason: ai.reason, note: 'indicators_remain_available_without_ai' } };
  const today = localToday(ctx.tz);
  const team = await withTenant(ctx.tenantId, (trx) => evaluatedTeam(trx, ctx.tenantId, ctx.tz, addDays(today, -90), addDays(today, -1)));
  const specialties = [...new Set(team.map((t) => t.specialty_id).filter(Boolean))] as string[];
  const refs = team.map((t, i) => ({ ref: `S${i + 1}`, staff_id: t.staff_id }));
  const input = {
    locale: ctx.locale, period_days: 90,
    staff: team.map((t, i) => ({
      ref: `S${i + 1}`, specialty_ref: t.specialty_id ? `sp${specialties.indexOf(t.specialty_id) + 1}` : null, completed: t.completed,
      indicators: Object.fromEntries(Object.entries(t.ev.indicators).map(([k, v]) => [k, { status: v.status, value: v.value, n: v.n, min_n: v.min_n }])),
      composite: { status: t.ev.composite.status, score: t.ev.composite.score },
    })),
  };
  const r = await callModel<{ insights: Array<{ staff_ref: string; explanation: string; development_suggestions: string[] }> }>(ctx, 'employee_insights', input,
    { team: digest(input) }, { kind: 'employee_insights', staff: team.length });
  let rejected = 0;
  const insights = r.output.insights.flatMap((x) => {
    const m = refs.find((y) => y.ref === x.staff_ref);
    if (!m || EMPLOYMENT_DECISION_RE.test(`${x.explanation} ${x.development_suggestions.join(' ')}`)) { rejected++; return []; }
    return [{ staff_id: m.staff_id, explanation: x.explanation, development_suggestions: x.development_suggestions }];
  });
  return { status: 'succeeded', result: { insights, rejected, ai_run_id: r.prov.ai_run_id, provider: r.prov.provider, model: r.prov.model } };
}

async function execute(ctx: Ctx): Promise<Outcome> {
  const gate = await withTenant(ctx.tenantId, async (trx) => {
    const ent = await loadEntitlements(trx, ctx.tenantId);
    if (!ent.features.get('feature.marketing_ai')?.enabled) return 'plan_feature_unavailable';
    if (ctx.job.requested_by) {
      const m = await trx.selectFrom('tenant_memberships').select(['role', 'granted_capabilities', 'revoked_capabilities', 'status'])
        .where('tenant_id', '=', ctx.tenantId).where('user_id', '=', ctx.job.requested_by).executeTakeFirst();
      const caps = m && m.status === 'active' ? effectiveCapabilities(m.role as TenantRole, m.granted_capabilities, m.revoked_capabilities) : new Set();
      const needed = ctx.job.kind === 'employee_insights' ? 'analytics.view' : 'marketing.manage';
      if (!caps.has(needed) || (ctx.job.kind === 'employee_insights' && m!.role === 'specialist')) return 'requester_lacks_permission';
    }
    return null;
  });
  if (gate) return { status: 'unavailable', errorCode: gate, result: { reason: gate } };
  switch (ctx.job.kind) {
    case 'monthly_plan':
    case 'weekly_plan': return planJob(ctx, ctx.job.kind);
    case 'recommendations': return recommendationsJob(ctx);
    case 'employee_insights': return insightsJob(ctx);
    case 'trend_assessment': {
      const r = await withTenant(ctx.tenantId, (trx) => assessTrends(trx, ctx.tenantId));
      if (r.sources === 0) return { status: 'insufficient_data', errorCode: 'no_trend_sources', result: r };
      return { status: 'succeeded', result: { ...r, source: 'rules' } };
    }
  }
}

const RETRYABLE = new Set(['timeout', 'rate_limited', 'provider_error', 'unavailable']);

/** Job handler: honest states, bounded retries, previous plans untouched on failure. */
export async function runAiJob(aiJobId: string, tenantId: string, attempt: number, mode: Mode = 'auto') {
  const job = await withTenant(tenantId, (trx) => trx.selectFrom('ai_jobs').selectAll().where('id', '=', aiJobId).executeTakeFirst());
  if (!job || !['queued', 'running'].includes(job.status)) return { skipped: true };
  const tenant = await withTenant(tenantId, (trx) => trx.selectFrom('tenants').select(['timezone', 'default_locale']).where('id', '=', tenantId).executeTakeFirstOrThrow());
  await withTenant(tenantId, (trx) => trx.updateTable('ai_jobs').set({ status: 'running', attempts: attempt, started_at: new Date(), error_code: null, error_message: null }).where('id', '=', aiJobId).execute());
  const ctx: Ctx = { tenantId, tz: tenant.timezone, locale: tenant.default_locale === 'en' ? 'en' : 'ar', job: { ...job, kind: job.kind as AiJobKind }, mode, attempt };
  try {
    const out = await execute(ctx);
    await withTenant(tenantId, (trx) => trx.updateTable('ai_jobs').set({
      status: out.status, error_code: out.errorCode ?? null, error_message: out.errorMessage ?? null, result_ref: JSON.stringify(out.result), finished_at: new Date(),
    }).where('id', '=', aiJobId).execute());
    return { status: out.status };
  } catch (e) {
    const err = e instanceof AiError ? e : null;
    const message = (e as Error).message?.slice(0, 500) ?? 'error';
    const retry = !!err && err.retryable && RETRYABLE.has(err.kind) && attempt < job.max_attempts;
    await withTenant(tenantId, (trx) => trx.updateTable('ai_jobs').set({
      status: retry ? 'queued' : 'failed', error_code: err?.kind ?? 'internal_error', error_message: message, finished_at: retry ? null : new Date(),
    }).where('id', '=', aiJobId).execute());
    if (retry) throw e;
    throw new PermanentJobError(message);
  }
}

export type { SnapshotData };
