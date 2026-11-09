import { registerJob, registerOutbox, registerPeriodic, withTenant } from './db';
import { ANALYSIS_JOB, failStuckAnalyses, runAnalysis } from './analysis/run';
import { CHANGE_TOPIC, CHANGES_JOB, processChanges, recordChange, scheduleDueChanges, type ChangeInput } from './memory/changes';
import { MEASURE_JOB, measureBusiness, scheduleMeasurements } from './memory/outcomes';

/** Loom background work: the analysis job (one per loom.analyses row) and a sweeper for stuck runs. */
registerJob(ANALYSIS_JOB, async (payload, ctx) => {
  if (!ctx.tenantId) throw new Error('loom analysis requires a business');
  const r = await runAnalysis(String(payload.analysis_id), ctx.tenantId);
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
