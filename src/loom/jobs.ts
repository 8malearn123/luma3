import { registerJob, registerPeriodic, withTenant } from './db';
import { ANALYSIS_JOB, failStuckAnalyses, runAnalysis } from './analysis/run';
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

/** Outgoing webhook delivery (signed POST, retried with the framework's backoff). */
registerJob(DELIVERY_JOB, async (payload, ctx) => deliverWebhook(await jobBusiness(ctx.tenantId, payload), String(payload.delivery_id), ctx.attempt));
