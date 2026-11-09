import { registerJob, registerOutbox, registerPeriodic, withTenant } from './db';
import { ANALYSIS_JOB, failStuckAnalyses, runAnalysis } from './analysis/run';
import { CHANGE_TOPIC, CHANGES_JOB, processChanges, recordChange, scheduleDueChanges, type ChangeInput } from './memory/changes';
import { MEASURE_JOB, measureBusiness, scheduleMeasurements } from './memory/outcomes';
import { failStuckPlannerRuns, PLAN_JOB, runPlannerRun } from './planner/run';
import { importDueOfficialSources } from './radar/calendar';
import { sweepSources } from './radar/sources';
import { jobBusiness } from './hosts';
import { DELIVERY_JOB, deliverWebhook } from './webhooks/outgoing';

/** Loom background work: the analysis job (one per loom.analyses row) and a sweeper for stuck runs. */
registerJob(ANALYSIS_JOB, async (payload, ctx) => {
  // LUMA tenants carry the tenant id; external businesses carry a verified business_id (hosts.ts).
  const businessId = await jobBusiness(ctx.tenantId, payload);
  const r = await runAnalysis(String(payload.analysis_id), businessId);
  if (!r && !ctx.tenantId) {
    // External businesses are scheduled in system scope, possibly before the analysis row committed: retry until visible.
    const row = await withTenant(businessId, (trx) => trx.selectFrom('loom.analyses').select('status').where('id', '=', String(payload.analysis_id)).executeTakeFirst());
    if (!row) throw new Error('analysis not visible yet');
  }
  return r ? { status: r.status } : { skipped: true };
});

registerPeriodic({ name: 'loom.stuck_analyses', everySec: 900, run: failStuckAnalyses });

// ── Phase 5: change aggregator and measurement (docs/LOOM_CORE.md §11–§12) ──
/** Host events arrive through the outbox topic `loom.change` (enqueued by src/server/loom-host/changes.ts). */
registerOutbox(CHANGE_TOPIC, async (ev) => {
  if (!ev.tenantId) return;
  await withTenant(ev.tenantId, (trx) => recordChange(trx, ev.tenantId!, ev.payload as unknown as ChangeInput));
});
registerJob(CHANGES_JOB, async (_payload, ctx) => {
  if (!ctx.tenantId) throw new Error('loom changes require a business');
  const s = await processChanges(ctx.tenantId);
  return { processed: s.processed, rechecked: s.rechecked, revisions: s.revisions.length };
});
registerJob(MEASURE_JOB, async (_payload, ctx) => {
  if (!ctx.tenantId) throw new Error('loom measurement requires a business');
  return { ...(await measureBusiness(ctx.tenantId)) };
});
registerPeriodic({ name: 'loom.change_aggregation', everySec: 300, run: async () => { await scheduleDueChanges(); } });
registerPeriodic({ name: 'loom.measurement', everySec: 3600, run: async () => { await scheduleMeasurements(); } });
/** Planner run (phase 3): one per loom.planner_runs row. Needs the host ports (registered by the host's job index). */
registerJob(PLAN_JOB, async (payload, ctx) => {
  if (!ctx.tenantId) throw new Error('loom plan requires a business');
  const r = await runPlannerRun(String(payload.run_id), ctx.tenantId);
  return r ? { status: r.status, source: r.source } : { skipped: true };
});
registerPeriodic({ name: 'loom.stuck_planner_runs', everySec: 900, run: failStuckPlannerRuns });
/** Radar (phase 4): official calendars (daily per source, with backoff) and business sources (6 h, with backoff), dedupe, re-cluster, stale marking. */
registerPeriodic({ name: 'loom.radar_sweep', everySec: 900, run: async () => { await importDueOfficialSources(); await sweepSources(); } });
/** Outgoing webhook delivery (signed POST, retried with the framework's backoff). */
registerJob(DELIVERY_JOB, async (payload, ctx) => deliverWebhook(await jobBusiness(ctx.tenantId, payload), String(payload.delivery_id), ctx.attempt));
