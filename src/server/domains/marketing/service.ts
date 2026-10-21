import type { z } from 'zod';
import { sql, withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { aiStatus } from '../../infra/ai';
import { audit, type AuditActor } from '../../infra/audit';
import { featureEnabled, type TenantAccess } from '../../tenancy/access';
import { monthBounds, localToday } from '../analytics/period';
import type { calendarEventInput, preferencesInput } from '@/shared/schemas/marketing';
import { channelReadiness } from './campaigns';
import { requestAiJob, type AiJobKind } from './pipeline';
import { listRecommendations } from './recommendations';

export const DEFAULT_PREFERENCES = {
  goals: [] as string[], monthly_budget_minor: null as number | null, max_discount_bp: 2000, tone: null as string | null, brand_style: null as string | null,
  channels: [] as string[], audience_notes: null as string | null, photography_resources: null as string | null, schedule_enabled: false,
  weekly_enabled: true, monthly_enabled: true, weekly_weekday: 0, monthly_day: 1, local_hour: 7, promote_products: true,
};

export async function getPreferences(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.selectFrom('marketing_preferences').selectAll().where('tenant_id', '=', access.tenantId).executeTakeFirst();
    const t = await trx.selectFrom('tenants').select(['city', 'timezone']).where('id', '=', access.tenantId).executeTakeFirstOrThrow();
    const branches = await trx.selectFrom('branches').select(['id', 'name', 'city']).where('tenant_id', '=', access.tenantId).where('status', '=', 'active').execute();
    return { ...DEFAULT_PREFERENCES, ...(r ? { ...r, goals: r.goals as string[] } : {}), saved: !!r, city: t.city, timezone: t.timezone, branches };
  });
}

export async function savePreferences(access: TenantAccess, actor: AuditActor, input: z.infer<typeof preferencesInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const values = { ...input, goals: JSON.stringify(input.goals), updated_by: actor.userId };
    await trx.insertInto('marketing_preferences').values({ tenant_id: access.tenantId, ...values })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ ...values, updated_at: new Date() })).execute();
    await audit(trx, actor, 'marketing.preferences_updated', { tenantId: access.tenantId, data: { fields: Object.keys(input) } });
    return { saved: true };
  }).then(() => getPreferences(access));
}

export async function listCalendar(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('marketing_calendar_events').selectAll().where('tenant_id', '=', access.tenantId).orderBy('starts_on').execute());
}

/** Owner-entered dates are the only seasonal source: entering them is the verification. */
export async function addCalendarEvent(access: TenantAccess, actor: AuditActor, input: z.infer<typeof calendarEventInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const row = await trx.insertInto('marketing_calendar_events').values({ tenant_id: access.tenantId, ...input, relevance_note: input.relevance_note ?? null, source_url: input.source_url ?? null, verified_by: actor.userId! })
      .returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'marketing.calendar_event_added', { tenantId: access.tenantId, targetType: 'calendar_event', targetId: row.id, data: { title: input.title, starts_on: input.starts_on } });
    return row;
  });
}

export async function deleteCalendarEvent(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.deleteFrom('marketing_calendar_events').where('id', '=', id).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('event');
    await audit(trx, actor, 'marketing.calendar_event_deleted', { tenantId: access.tenantId, targetType: 'calendar_event', targetId: id });
    return { deleted: true };
  });
}

/** Honest AI status: configuration, last verified call, monthly budget usage. */
export async function marketingAiStatus(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const last = await trx.selectFrom('ai_runs').select(['created_at']).where('tenant_id', '=', access.tenantId).where('status', '=', 'succeeded').orderBy('created_at', 'desc').executeTakeFirst();
    const lastFail = await trx.selectFrom('ai_runs').select(['created_at', 'status']).where('tenant_id', '=', access.tenantId).where('status', '!=', 'succeeded').orderBy('created_at', 'desc').executeTakeFirst();
    const month = monthBounds(localToday(access.timezone)).from;
    const used = await trx.selectFrom('usage_counters').select('value').where('tenant_id', '=', access.tenantId).where('metric', '=', 'ai_runs').where('period_start', '=', month).executeTakeFirst();
    const lim = access.plan.features.get('limit.ai_runs_monthly');
    return {
      ...(await aiStatus(last?.created_at ?? null)),
      feature_enabled: featureEnabled(access, 'feature.marketing_ai'),
      budget: { limit: lim?.enabled ? lim.limit : 0, used: used?.value ?? 0, period_start: month },
      last_failure: lastFail ? { at: lastFail.created_at, status: lastFail.status } : null,
    };
  });
}

export async function listJobs(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('ai_jobs').select(['id', 'kind', 'period_key', 'status', 'attempts', 'max_attempts', 'error_code', 'error_message', 'trigger', 'result_ref', 'created_at', 'started_at', 'finished_at', 'regeneration_of', 'target_plan_id'])
    .where('tenant_id', '=', access.tenantId).orderBy('created_at', 'desc').limit(30).execute());
}

function periodStartFromKey(kind: AiJobKind, key: string) {
  if (kind === 'employee_insights') return undefined;
  return kind === 'monthly_plan' ? `${key}-01` : key;
}

export async function requestJob(access: TenantAccess, actor: AuditActor, input: { kind: AiJobKind; period_start?: string; mode?: 'auto' | 'rules' }) {
  const r = await requestAiJob(access.tenantId, { kind: input.kind, periodStart: input.period_start, trigger: 'manual', requestedBy: actor.userId, mode: input.mode });
  await withTenant(access.tenantId, (trx) => audit(trx, actor, 'marketing.ai_job_requested', { tenantId: access.tenantId, targetType: 'ai_job', targetId: r.job.id, data: { kind: input.kind, created: r.created } }));
  return r;
}

/** A retry is a new job for the same period; the failed job and existing plans stay as they were. */
export async function retryJob(access: TenantAccess, actor: AuditActor, id: string, mode?: 'auto' | 'rules') {
  const job = await withTenant(access.tenantId, (trx) => trx.selectFrom('ai_jobs').selectAll().where('id', '=', id).executeTakeFirst());
  if (!job) throw Errors.notFound('job');
  if (['queued', 'running'].includes(job.status)) throw Errors.conflict('job_in_progress', 'This analysis is still running');
  const kind = job.kind as AiJobKind;
  return requestAiJob(access.tenantId, { kind, periodStart: periodStartFromKey(kind, job.period_key), trigger: 'manual', requestedBy: actor.userId, regenerationOf: id, targetPlanId: job.target_plan_id, mode });
}

export async function regeneratePlan(access: TenantAccess, actor: AuditActor, planId: string, mode?: 'auto' | 'rules') {
  const plan = await withTenant(access.tenantId, (trx) => trx.selectFrom('marketing_plans').select(['id', 'kind', 'period_start', 'is_example']).where('id', '=', planId).executeTakeFirst());
  if (!plan) throw Errors.notFound('plan');
  if (plan.is_example) throw Errors.invalid('example_plan', 'Example plans are not regenerated');
  return requestAiJob(access.tenantId, { kind: plan.kind === 'monthly' ? 'monthly_plan' : 'weekly_plan', periodStart: plan.period_start, trigger: 'manual', requestedBy: actor.userId, targetPlanId: plan.id, mode });
}

/** Limited dashboard summary: a few top items, honest statuses, no alarms. */
export async function marketingSummary(access: TenantAccess) {
  const [ai, recs] = await Promise.all([marketingAiStatus(access), listRecommendations(access)]);
  return withTenant(access.tenantId, async (trx) => {
    const today = localToday(access.timezone);
    const plans = await trx.selectFrom('marketing_plans').select(['id', 'kind', 'title', 'status', 'period_start', 'period_end', 'is_example'])
      .where('tenant_id', '=', access.tenantId).where('period_end', '>=', today).where('status', 'not in', ['rejected', 'completed'])
      .orderBy('period_start').limit(4).execute();
    const jobs = await trx.selectFrom('ai_jobs').select(['id', 'kind', 'status', 'error_code', 'created_at']).where('tenant_id', '=', access.tenantId).orderBy('created_at', 'desc').limit(3).execute();
    const trends = await trx.selectFrom('trend_assessments').select(sql<number>`count(*)::int`.as('n')).where('tenant_id', '=', access.tenantId).where('status', '=', 'open').executeTakeFirstOrThrow();
    const sources = await trx.selectFrom('trend_sources').select(sql<number>`count(*)::int`.as('n')).where('tenant_id', '=', access.tenantId).where('status', '=', 'active').executeTakeFirstOrThrow();
    const cal = await trx.selectFrom('marketing_calendar_events').select(sql<number>`count(*)::int`.as('n')).where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
    const campaigns = await trx.selectFrom('campaigns').select(['status', sql<number>`count(*)::int`.as('n')]).where('tenant_id', '=', access.tenantId).groupBy('status').execute();
    return {
      ai,
      top_recommendations: recs.slice(0, 3).map((r) => ({ id: r.id, title: r.title, category: r.category, confidence: r.confidence, source_type: r.source_type })),
      open_recommendations: recs.length,
      plans, recent_jobs: jobs,
      trends: { open: trends.n, active_sources: sources.n },
      calendar: { verified_events: cal.n },
      campaigns: Object.fromEntries(campaigns.map((c) => [c.status, c.n])),
      channels: { email: channelReadiness('email'), sms: channelReadiness('sms'), whatsapp: channelReadiness('whatsapp'), in_app: channelReadiness('in_app') },
      campaigns_enabled: featureEnabled(access, 'feature.campaigns'),
    };
  });
}
