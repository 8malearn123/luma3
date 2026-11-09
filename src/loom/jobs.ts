import { registerJob, registerPeriodic } from './db';
import { ANALYSIS_JOB, failStuckAnalyses, runAnalysis } from './analysis/run';
import { importDueOfficialSources } from './radar/calendar';
import { sweepSources } from './radar/sources';

/** Loom background work: the analysis job (one per loom.analyses row) and a sweeper for stuck runs. */
registerJob(ANALYSIS_JOB, async (payload, ctx) => {
  if (!ctx.tenantId) throw new Error('loom analysis requires a business');
  const r = await runAnalysis(String(payload.analysis_id), ctx.tenantId);
  return r ? { status: r.status } : { skipped: true };
});

registerPeriodic({ name: 'loom.stuck_analyses', everySec: 900, run: failStuckAnalyses });
/** Radar (phase 4): official calendars (daily per source, with backoff) and business sources (6 h, with backoff), dedupe, re-cluster, stale marking. */
registerPeriodic({ name: 'loom.radar_sweep', everySec: 900, run: async () => { await importDueOfficialSources(); await sweepSources(); } });
