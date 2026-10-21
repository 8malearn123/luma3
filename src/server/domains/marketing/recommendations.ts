import type { z } from 'zod';
import { sql, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { proposePrice } from '../catalog/service';
import type { pricingProposalFromRecommendation, recommendationDecision } from '@/shared/schemas/marketing';
import type { Provenance, RecDraft } from './types';

/**
 * Recommendations stay available until the owner decides or the evidence
 * changes materially (> 20% change of a measured metric), in which case the old
 * one is superseded by the new one. Identical evidence never duplicates.
 */

const MATERIAL_CHANGE = 0.2;

function materiallyDifferent(oldM: Record<string, { value: number | null }>, newM: RecDraft['measured_metrics']) {
  for (const [k, v] of Object.entries(newM)) {
    const o = oldM[k]?.value;
    if (o === undefined) return true;
    if (o === null || v.value === null) { if (o !== v.value) return true; continue; }
    const base = Math.max(Math.abs(o), 1e-9);
    if (Math.abs(v.value - o) / base > MATERIAL_CHANGE) return true;
  }
  return false;
}

export async function saveRecommendations(trx: Tx, tenantId: string, recs: RecDraft[], prov: Provenance, meta: { snapshotId: string; dataAsOf: Date; planId?: string | null }) {
  const saved: string[] = [];
  let kept = 0, superseded = 0;
  for (const r of recs) {
    const live = await trx.selectFrom('recommendations').select(['id', 'measured_metrics', 'status']).where('tenant_id', '=', tenantId)
      .where('fingerprint', '=', r.fingerprint).where('status', 'in', ['open', 'deferred']).forUpdate().executeTakeFirst();
    if (live) {
      if (!materiallyDifferent(live.measured_metrics as Record<string, { value: number | null }>, r.measured_metrics)) { kept++; continue; }
      await trx.updateTable('recommendations').set({ status: 'superseded' }).where('id', '=', live.id).execute();
      superseded++;
    }
    const reviewDays = r.horizon === 'weekly' ? 7 : r.horizon === 'monthly' ? 30 : 30;
    const expiresDays = r.horizon === 'weekly' ? 14 : r.horizon === 'monthly' ? 45 : 90;
    const row = await trx.insertInto('recommendations').values({
      tenant_id: tenantId, title: r.title, category: r.category, horizon: r.horizon, period_start: r.period_start, period_end: r.period_end,
      evidence_refs: JSON.stringify(r.evidence_refs), measured_metrics: JSON.stringify(r.measured_metrics),
      opportunity: r.opportunity, suggested_action: r.suggested_action, target_segment_id: null, timing: r.timing,
      estimated_cost: JSON.stringify(r.estimated_cost), capacity_check: JSON.stringify(r.capacity_check), margin_check: JSON.stringify(r.margin_check),
      draft_content: r.draft_content ? JSON.stringify({ ...r.draft_content, service_ids: r.service_ids }) : JSON.stringify({ text: null, service_ids: r.service_ids }),
      channel: r.channel, prerequisites: JSON.stringify(r.prerequisites), success_metric: r.success_metric, experiment_design: r.experiment_design,
      confidence: r.confidence, limitations: r.limitations, proposed_target: r.proposed_target, forecast: r.forecast,
      validation: JSON.stringify(r.validation), data_as_of: meta.dataAsOf,
      review_at: new Date(meta.dataAsOf.getTime() + reviewDays * 86_400_000), expires_at: new Date(meta.dataAsOf.getTime() + expiresDays * 86_400_000),
      source_type: prov.source_type, provider: prov.provider, model: prov.model, prompt_version: prov.prompt_version, ai_run_id: prov.ai_run_id,
      metric_snapshot_id: meta.snapshotId, fingerprint: r.fingerprint, plan_id: meta.planId ?? null,
    }).returning('id').executeTakeFirstOrThrow();
    saved.push(row.id);
  }
  return { saved, kept, superseded };
}

export async function listRecommendations(access: TenantAccess, status?: string) {
  return withTenant(access.tenantId, async (trx) => {
    await expireRecommendations(trx, access.tenantId);
    let q = trx.selectFrom('recommendations').selectAll().where('tenant_id', '=', access.tenantId);
    q = status ? q.where('status', '=', status) : q.where('status', 'in', ['open', 'deferred']);
    const rows = await q.orderBy('created_at', 'desc').limit(100).execute();
    const order = { high: 0, medium: 1, low: 2 } as const;
    return rows.sort((a, b) => order[a.confidence as keyof typeof order] - order[b.confidence as keyof typeof order]);
  });
}

export async function expireRecommendations(trx: Tx, tenantId: string) {
  await sql`update recommendations set status = 'expired' where tenant_id = ${tenantId} and status in ('open', 'deferred') and expires_at < now()`.execute(trx);
  // Deferred items come back for review on their review date.
  await sql`update recommendations set status = 'open' where tenant_id = ${tenantId} and status = 'deferred' and review_at <= now()`.execute(trx);
}

export async function decideRecommendation(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof recommendationDecision>) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.selectFrom('recommendations').select(['id', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!r) throw Errors.notFound('recommendation');
    if (['expired', 'superseded'].includes(r.status)) throw Errors.conflict('recommendation_closed', 'This recommendation is no longer current');
    const reviewAt = input.decision === 'deferred' ? (input.review_at ? new Date(`${input.review_at}T06:00:00Z`) : new Date(Date.now() + 14 * 86_400_000)) : undefined;
    await trx.updateTable('recommendations').set({
      status: input.decision, decided_by: input.decision === 'open' ? null : actor.userId, decided_at: input.decision === 'open' ? null : new Date(),
      ...(reviewAt ? { review_at: reviewAt, expires_at: new Date(reviewAt.getTime() + 60 * 86_400_000) } : {}),
    }).where('id', '=', id).execute();
    await audit(trx, actor, 'marketing.recommendation_decided', { tenantId: access.tenantId, targetType: 'recommendation', targetId: id, data: { decision: input.decision, note: input.note } });
    return { id, status: input.decision };
  });
}

/**
 * Pricing recommendations never change prices. On the owner's click this
 * creates a catalog price PROPOSAL (source 'recommendation') that still needs
 * the normal approval.
 */
export async function proposePriceFromRecommendation(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof pricingProposalFromRecommendation>) {
  if (!hasCapability(access, 'catalog.edit')) throw Errors.forbidden();
  const rec = await withTenant(access.tenantId, (trx) => trx.selectFrom('recommendations').select(['id', 'category', 'draft_content', 'title', 'status']).where('id', '=', id).executeTakeFirst());
  if (!rec) throw Errors.notFound('recommendation');
  if (rec.category !== 'pricing') throw Errors.invalid('not_a_pricing_recommendation');
  const ids = ((rec.draft_content as { service_ids?: string[] } | null)?.service_ids) ?? [];
  if (!ids.includes(input.service_id)) throw Errors.invalid('service_not_in_recommendation');
  return proposePrice(access, actor, input.service_id, { proposed_price_minor: input.proposed_price_minor, reason: `Loom recommendation: ${rec.title}`.slice(0, 500) }, 'recommendation');
}
