import { emitLoomEvent } from '../webhooks/outgoing';
import { schedule, withSystem, withTenant } from '../db';
import { ensureConnection } from '../analysis/run';
import { connectorFor } from '../connectors/registry';
import { loadDataset } from '../dataset';
import { recordEvent } from '../opportunities/store';
import { L } from '../util/text';
import { addDays, localDateOf, localToday } from '../util/time';
import { recordChange } from './changes';
import { recordExecution, type GoalMetric } from './initiatives';
import { recordLadder } from './ladder';
import { measureInitiative, type ExternalFactor } from './measure';

/**
 * Measurement job (§10.3): for each open initiative of a business
 *  1. records the execution observed by the connector (a LUMA campaign that
 *     was sent: actual dates, audience, channel) — once;
 *  2. once the window has closed: stage `completed`, then measures it
 *     (holdout / pre-post with control / guardrails), stores an outcome
 *     (append-only, one per window), stage `measured`, opportunity `measured`;
 *  3. a measured campaign emits a `campaign_result` change signal (learning).
 * Idempotent: re-running finds nothing new (unique outcome per window,
 * connector execution once, status guards).
 */
export const MEASURE_JOB = 'loom.measure';

export type MeasureSummary = { executions: number; completed: number; measured: number };

export async function measureBusiness(businessId: string, opts: { now?: Date } = {}): Promise<MeasureSummary> {
  const now = opts.now ?? new Date();
  const sum: MeasureSummary = { executions: 0, completed: 0, measured: 0 };
  const open = await withTenant(businessId, (trx) => trx.selectFrom('loom.initiatives').selectAll().where('business_id', '=', businessId)
    .where('status', 'in', ['scheduled', 'executing', 'completed']).execute());
  if (!open.length) return sum;
  const conn = await withTenant(businessId, (trx) => ensureConnection(trx, businessId));
  const connector = connectorFor(conn.kind);
  const ds = await loadDataset(connector, { ...conn, as_of: now });
  const tz = ds.business.timezone;
  const today = localToday(tz, now);

  for (const init of open) {
    let windowFrom = init.window_from, windowTo = init.window_to;
    let executed = !!init.execution;
    const groups = init.artifact_kind === 'campaign_draft' && connector.campaignGroups ? await connector.campaignGroups({ ...conn, as_of: now }, init.artifact_ref) : null;
    // 1. Connector-observed execution (campaign send).
    if (init.artifact_kind === 'campaign_draft') {
      const camp = ds.campaigns.find((c) => c.id === init.artifact_ref);
      if (camp?.started_at) {
        const from = localDateOf(camp.started_at, tz);
        const to = addDays(from, Math.max(1, groups?.window_days ?? 14) - 1);
        windowFrom = from; windowTo = to;
        if (!executed) {
          const id = await withTenant(businessId, (trx) => recordExecution(trx, businessId, init.id, {
            source: 'connector', executed_from: from, executed_to: to, audience_size: groups?.target?.members ?? camp.targeted, channel: camp.channel, actual_cost_minor: camp.cost_minor,
            data: { campaign_id: camp.id, holdout: groups?.holdout?.members ?? camp.holdout, attribution_window_days: groups?.window_days ?? 14 },
          }));
          if (id) sum.executions++;
          executed = true;
          await withTenant(businessId, (trx) => trx.updateTable('loom.initiatives').set({ window_from: from, window_to: to }).where('id', '=', init.id).execute());
        }
      }
    } else if (init.execution) {
      const ex = init.execution as { from: string; to: string };
      windowFrom = ex.from; windowTo = ex.to;
    }
    if (windowTo >= today) continue;
    // 2. Window closed → completed, then measured.
    if (init.status !== 'completed') {
      await withTenant(businessId, async (trx) => {
        const u = await trx.updateTable('loom.initiatives').set({ status: 'completed', completed_at: now }).where('id', '=', init.id).where('status', 'in', ['scheduled', 'executing']).returning('id').executeTakeFirst();
        if (u) await recordLadder(trx, businessId, { opportunity_id: init.opportunity_id, initiative_id: init.id, stage: 'completed', data: { window: { from: windowFrom, to: windowTo } } });
      });
      sum.completed++;
    }
    const factors = await externalFactors(businessId, init.offering_ids, windowFrom, windowTo);
    const execution = init.execution as { actual_cost_minor?: number | null } | null;
    const outcome = measureInitiative({
      ds, groups,
      initiative: {
        offering_ids: init.offering_ids, window_from: windowFrom, window_to: windowTo, artifact_kind: init.artifact_kind as 'plan_action', artifact_ref: init.artifact_ref,
        goal_metrics: init.goal_metrics as GoalMetric[], executed, actual_cost_minor: execution?.actual_cost_minor ?? null,
      },
      factors,
    });
    const measured = await withTenant(businessId, async (trx) => {
      const row = await trx.insertInto('loom.outcomes').values({
        business_id: businessId, initiative_id: init.id, window_from: windowFrom, window_to: windowTo, measurement_design: outcome.design, measurement_quality: outcome.quality,
        causal: outcome.causal, primary_metrics: JSON.stringify(outcome.primary), guardrails: JSON.stringify(outcome.guardrails), attributed: outcome.attributed ? JSON.stringify(outcome.attributed) : null,
        incremental: outcome.incremental ? JSON.stringify(outcome.incremental) : null, external_factors: JSON.stringify(outcome.external_factors),
        limitations: JSON.stringify(outcome.limitations), learnings: JSON.stringify(outcome.learnings), data_version: ds.meta.data_version,
      }).onConflict((oc) => oc.columns(['initiative_id', 'window_to']).doNothing()).returning('id').executeTakeFirst();
      if (!row) return false;
      await trx.updateTable('loom.initiatives').set({
        status: 'measured', measured_at: now, measurement_quality: outcome.quality, external_factors: JSON.stringify(outcome.external_factors), learnings: JSON.stringify(outcome.learnings),
        results: JSON.stringify({ outcome_id: row.id, design: outcome.design, quality: outcome.quality, causal: outcome.causal, primary: outcome.primary, guardrails: outcome.guardrails, attributed: outcome.attributed, incremental: outcome.incremental, limitations: outcome.limitations, periods: outcome.periods }),
      }).where('id', '=', init.id).execute();
      await emitLoomEvent(trx, businessId, 'outcome.measured', row.id, { initiative_id: init.id, opportunity_id: init.opportunity_id, window: { from: windowFrom, to: windowTo }, quality: outcome.quality, causal: outcome.causal, primary: outcome.primary, guardrails: outcome.guardrails });
      await recordLadder(trx, businessId, { opportunity_id: init.opportunity_id, initiative_id: init.id, stage: 'measured', action: outcome.quality, data: { outcome_id: row.id, causal: outcome.causal } });
      const opp = await trx.selectFrom('loom.opportunities').select('status').where('id', '=', init.opportunity_id).executeTakeFirstOrThrow();
      if (['accepted', 'converted', 'executed'].includes(opp.status)) {
        await trx.updateTable('loom.opportunities').set({ status: 'measured' }).where('id', '=', init.opportunity_id).execute();
        await recordEvent(trx, businessId, init.opportunity_id, { event: 'measured', from: opp.status, to: 'measured', data: { initiative_id: init.id, quality: outcome.quality } });
      }
      if (init.artifact_kind === 'campaign_draft') await recordChange(trx, businessId, { type: 'campaign_result', scope: `initiative:${init.id}`, data: { campaign_id: init.artifact_ref, quality: outcome.quality } }, { now });
      return true;
    });
    if (measured) sum.measured++;
  }
  return sum;
}

const FACTOR: Record<string, { type: ExternalFactor['type']; label: ReturnType<typeof L> }> = {
  inventory: { type: 'stockout', label: L('نفاد أو انخفاض مادة خلال النافذة', 'A material ran low or out during the window') },
  margin: { type: 'price_change', label: L('تغيّر سعر أو تكلفة الخدمة خلال النافذة', 'The offering’s price or cost changed during the window') },
  capacity: { type: 'capacity_change', label: L('إجازة معتمدة قلّصت الطاقة خلال النافذة', 'Approved leave reduced capacity during the window') },
};

/** Stockouts, price/cost changes and capacity cuts detected by the change aggregator on the initiative's offerings during its window. */
async function externalFactors(businessId: string, offeringIds: string[], from: string, to: string): Promise<ExternalFactor[]> {
  const rows = await withTenant(businessId, (trx) => trx.selectFrom('loom.change_signals').select(['id', 'type', 'result', 'first_seen_at']).where('business_id', '=', businessId)
    .where('type', 'in', ['inventory', 'margin', 'capacity']).where('status', '=', 'processed')
    .where('first_seen_at', '>=', new Date(`${addDays(from, -1)}T00:00:00Z`)).where('first_seen_at', '<', new Date(`${addDays(to, 2)}T00:00:00Z`)).execute());
  const set = new Set(offeringIds);
  return rows.filter((r) => ((r.result as { offering_ids?: string[] }).offering_ids ?? []).some((o) => set.has(o)))
    .map((r) => ({ type: FACTOR[r.type]!.type, ref: r.id, at: r.first_seen_at.toISOString().slice(0, 10), label: FACTOR[r.type]!.label, contaminates: true }));
}

/** Periodic fan-out: one `loom.measure` job per business with open initiatives (deduplicated per hour). */
export async function scheduleMeasurements(now = new Date()) {
  const rows = await withSystem('loom: open initiatives', (trx) => trx.selectFrom('loom.initiatives').select('business_id').distinct()
    .where('status', 'in', ['scheduled', 'executing', 'completed']).execute());
  const hour = now.toISOString().slice(0, 13);
  for (const r of rows) await withTenant(r.business_id, (trx) => schedule(trx, MEASURE_JOB, {}, { tenantId: r.business_id, dedupeKey: `loom_measure:${r.business_id}:${hour}`, maxAttempts: 3 }));
  return rows.length;
}
