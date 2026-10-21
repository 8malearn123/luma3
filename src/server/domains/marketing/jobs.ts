import { DateTime } from 'luxon';
import { sql, withSystem, withTenant } from '../../db/client';
import { schedule } from '../../infra/outbox';
import { registerJob, registerPeriodic } from '../../jobs/registry';
import { addDays } from '../analytics/period';
import { CAMPAIGN_SEND_JOB, runCampaignSend } from './campaigns';
import { AI_JOB_KIND, requestAiJob, runAiJob } from './pipeline';
import { assessTrends, fetchSource } from './trends';

const TREND_FETCH_JOB = 'marketing.trend_fetch';

registerJob(AI_JOB_KIND, async (payload, ctx) => {
  if (!ctx.tenantId) throw new Error('ai job requires a tenant');
  return runAiJob(String(payload.ai_job_id), ctx.tenantId, ctx.attempt, payload.mode === 'rules' ? 'rules' : 'auto');
});

registerJob(CAMPAIGN_SEND_JOB, async (payload, ctx) => {
  if (!ctx.tenantId) throw new Error('campaign send requires a tenant');
  return runCampaignSend(ctx.tenantId, String(payload.campaign_id));
});

registerJob(TREND_FETCH_JOB, async (_payload, ctx) => {
  if (!ctx.tenantId) throw new Error('trend fetch requires a tenant');
  const tenantId = ctx.tenantId;
  const sources = await withTenant(tenantId, (trx) => trx.selectFrom('trend_sources').select('id').where('tenant_id', '=', tenantId).where('status', '!=', 'disabled').execute());
  const results = [];
  for (const s of sources) results.push(await fetchSource(tenantId, s.id));
  const assessed = await withTenant(tenantId, (trx) => assessTrends(trx, tenantId));
  return { fetched: results.length, assessed };
});

/**
 * Scheduled Loom runs in each business's timezone. Idempotent per
 * tenant/kind/period: requestAiJob(trigger 'schedule') never creates a second
 * job for a period that already has a live or finished job.
 */
export async function runMarketingScheduler(now = new Date()) {
  const prefs = await withSystem('marketing scheduler fan-out', (trx) => sql<{
    tenant_id: string; timezone: string; weekly_weekday: number; monthly_day: number; local_hour: number; weekly_enabled: boolean; monthly_enabled: boolean;
  }>`select p.tenant_id, t.timezone, p.weekly_weekday, p.monthly_day, p.local_hour, p.weekly_enabled, p.monthly_enabled
     from marketing_preferences p join tenants t on t.id = p.tenant_id
     where p.schedule_enabled and t.status in ('active', 'onboarding')`.execute(trx));
  const requested: Array<{ tenant_id: string; kind: string; created: boolean }> = [];
  for (const p of prefs.rows) {
    const local = DateTime.fromJSDate(now, { zone: p.timezone });
    if (local.hour < p.local_hour) continue;
    const today = local.toISODate()!;
    try {
      if (p.weekly_enabled && local.weekday % 7 === p.weekly_weekday) {
        const r = await requestAiJob(p.tenant_id, { kind: 'weekly_plan', periodStart: today, trigger: 'schedule', requestedBy: null });
        requested.push({ tenant_id: p.tenant_id, kind: 'weekly_plan', created: r.created });
      }
      if (p.monthly_enabled && local.day === p.monthly_day) {
        // Early in the month: plan this month; later: plan the next one.
        const target = p.monthly_day <= 7 ? today : addDays(`${today.slice(0, 8)}28`, 4);
        const r = await requestAiJob(p.tenant_id, { kind: 'monthly_plan', periodStart: target, trigger: 'schedule', requestedBy: null });
        requested.push({ tenant_id: p.tenant_id, kind: 'monthly_plan', created: r.created });
      }
      await withTenant(p.tenant_id, (trx) => schedule(trx, TREND_FETCH_JOB, {}, { tenantId: p.tenant_id, dedupeKey: `trend_fetch:${p.tenant_id}:${today}`, maxAttempts: 2 }));
    } catch (e) {
      console.error('[marketing.scheduler]', p.tenant_id, (e as Error).message);
    }
  }
  return requested;
}

registerPeriodic({ name: 'marketing.scheduler', everySec: 3600, run: async () => { await runMarketingScheduler(); } });
