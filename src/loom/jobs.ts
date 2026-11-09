import { registerJob, registerPeriodic } from './db';
import { ANALYSIS_JOB, failStuckAnalyses, runAnalysis } from './analysis/run';

/** Loom background work: the analysis job (one per loom.analyses row) and a sweeper for stuck runs. */
registerJob(ANALYSIS_JOB, async (payload, ctx) => {
  if (!ctx.tenantId) throw new Error('loom analysis requires a business');
  const r = await runAnalysis(String(payload.analysis_id), ctx.tenantId);
  return r ? { status: r.status } : { skipped: true };
});

registerPeriodic({ name: 'loom.stuck_analyses', everySec: 900, run: failStuckAnalyses });
