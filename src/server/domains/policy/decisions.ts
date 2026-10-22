import type { Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyUsers } from '../../infra/notify';
import { assertTenantAssets } from '../assets/service';
import type { PolicyAction } from '@/shared/schemas/policy';
import { APPEAL_PATH } from './payment-terms';

export type EvidenceRef = { type: 'incident' | 'asset' | 'note'; id?: string; note?: string };

export type CreateDecisionArgs = {
  scope: 'tenant' | 'platform';
  /** Required for tenant scope; must be NULL for platform scope. */
  tenantId: string | null;
  tenantCustomerId?: string | null;
  customerUserId?: string | null;
  action: PolicyAction;
  reason: string;
  customerExplanationAr?: string | null;
  customerExplanationEn?: string | null;
  evidenceRefs?: EvidenceRef[];
  /** The authorised human reviewer. Rules and AI never decide. */
  reviewerId: string;
  effectiveAt?: Date;
  expiresAt?: Date | null;
  reviewAt?: Date | null;
  supersedesId?: string | null;
  ruleId?: string | null;
  isExperimental?: boolean;
  sourceIncidentId?: string | null;
  actor: AuditActor;
  /** Skip the customer notification (seed scripts). */
  silent?: boolean;
};

/**
 * Low-level decision writer used by the tenant and platform services (and the
 * seed script). Callers MUST already have authorised the reviewer:
 *  - tenant scope: incidents.review + step-up, inside withTenant(tenantId);
 *  - platform scope: platform.policy.review (+ platform_owner for suspension)
 *    + step-up, inside withSystem.
 * Supersession is explicit: the replaced decision becomes `superseded`.
 */
export async function createDecision(trx: Tx, a: CreateDecisionArgs) {
  if (a.scope === 'tenant' && !a.tenantId) throw new Error('tenant decision requires tenantId');
  if (a.scope === 'platform' && a.tenantId) throw new Error('platform decision cannot carry tenantId');
  if (a.action === 'suspend_account' && a.scope !== 'platform') throw Errors.forbidden('Account suspension is platform-only');
  const effectiveAt = a.effectiveAt ?? new Date();
  if (a.expiresAt && a.expiresAt <= effectiveAt) throw Errors.invalid('invalid_dates', 'expires_at must be after effective_at');
  if (a.reviewAt && a.reviewAt <= effectiveAt) throw Errors.invalid('invalid_dates', 'review_at must be after effective_at');

  let tenantCustomerId = a.tenantCustomerId ?? null;
  let customerUserId = a.customerUserId ?? null;
  if (a.scope === 'tenant') {
    if (!tenantCustomerId) throw Errors.invalid('customer_required');
    const tc = await trx.selectFrom('tenant_customers').select(['id', 'user_id']).where('tenant_id', '=', a.tenantId!).where('id', '=', tenantCustomerId).executeTakeFirst();
    if (!tc) throw Errors.notFound('customer');
    customerUserId = tc.user_id;
  } else {
    tenantCustomerId = null;
    if (!customerUserId) throw Errors.invalid('customer_required');
    const u = await trx.selectFrom('users').select('id').where('id', '=', customerUserId).executeTakeFirst();
    if (!u) throw Errors.notFound('customer');
  }

  // Evidence must belong to the deciding scope.
  const refs = a.evidenceRefs ?? [];
  const incidentIds = refs.filter((r) => r.type === 'incident').map((r) => r.id!);
  if (a.sourceIncidentId) incidentIds.push(a.sourceIncidentId);
  if (incidentIds.length) {
    let q = trx.selectFrom('customer_incidents').select(['id']).where('id', 'in', [...new Set(incidentIds)]);
    if (a.scope === 'tenant') q = q.where('tenant_id', '=', a.tenantId!).where('tenant_customer_id', '=', tenantCustomerId!);
    else q = q.where('customer_user_id', '=', customerUserId!).where('escalation_status', 'is not', null);
    const found = await q.execute();
    if (found.length !== new Set(incidentIds).size) throw Errors.invalid('invalid_evidence', 'An evidence reference is not available to this reviewer');
  }
  const assetIds = refs.filter((r) => r.type === 'asset').map((r) => r.id!);
  if (assetIds.length) {
    if (a.scope !== 'tenant') throw Errors.invalid('invalid_evidence', 'Platform decisions reference escalated incidents, not files');
    await assertTenantAssets(trx, a.tenantId!, assetIds).catch(() => { throw Errors.invalid('invalid_evidence'); });
  }

  if (a.ruleId) {
    let q = trx.selectFrom('policy_rules').select('id').where('id', '=', a.ruleId).where('scope', '=', a.scope);
    if (a.scope === 'tenant') q = q.where('tenant_id', '=', a.tenantId!);
    if (!(await q.executeTakeFirst())) throw Errors.invalid('invalid_rule');
  }

  let superseded: { id: string; action: string } | null = null;
  if (a.supersedesId) {
    let q = trx.selectFrom('policy_decisions').select(['id', 'action', 'status', 'scope', 'tenant_customer_id', 'customer_user_id'])
      .where('id', '=', a.supersedesId).where('scope', '=', a.scope);
    q = a.scope === 'tenant' ? q.where('tenant_id', '=', a.tenantId!) : q.where('tenant_id', 'is', null);
    const prev = await q.forUpdate().executeTakeFirst();
    if (!prev) throw Errors.notFound('decision');
    const sameCustomer = a.scope === 'tenant' ? prev.tenant_customer_id === tenantCustomerId : prev.customer_user_id === customerUserId;
    if (!sameCustomer) throw Errors.invalid('supersedes_invalid', 'The superseded decision concerns another customer');
    if (prev.status !== 'active') throw Errors.conflict('decision_not_active', 'Only an active decision can be superseded');
    await trx.updateTable('policy_decisions').set({ status: 'superseded', ended_at: new Date(), ended_by: a.reviewerId, end_reason: 'superseded' })
      .where('id', '=', prev.id).execute();
    superseded = { id: prev.id, action: prev.action };
  }

  const row = await trx.insertInto('policy_decisions').values({
    scope: a.scope, tenant_id: a.tenantId, tenant_customer_id: tenantCustomerId, customer_user_id: customerUserId,
    action: a.action, reason: a.reason, customer_explanation_ar: a.customerExplanationAr ?? null, customer_explanation_en: a.customerExplanationEn ?? null,
    evidence_refs: JSON.stringify(refs), rule_id: a.ruleId ?? null, reviewer_id: a.reviewerId, effective_at: effectiveAt,
    expires_at: a.expiresAt ?? null, review_at: a.reviewAt ?? null, supersedes_id: a.supersedesId ?? null,
    is_experimental: a.isExperimental ?? false, source_incident_id: a.sourceIncidentId ?? null,
  }).returningAll().executeTakeFirstOrThrow();

  if (superseded) {
    await audit(trx, a.actor, 'policy_decision.superseded', { tenantId: a.tenantId, targetType: 'policy_decision', targetId: superseded.id, data: { by: row.id, from_action: superseded.action, to_action: a.action } });
  }
  await audit(trx, a.actor, 'policy_decision.created', {
    tenantId: a.tenantId, targetType: 'policy_decision', targetId: row.id,
    data: { scope: a.scope, action: a.action, supersedes: a.supersedesId ?? null, rule_id: a.ruleId ?? null, expires_at: a.expiresAt ?? null, review_at: a.reviewAt ?? null, experimental: a.isExperimental ?? false },
  });

  if (customerUserId && !a.silent && a.action !== 'default') {
    await notifyUsers(trx, a.tenantId, [customerUserId], {
      kind: 'policy.decision',
      title_ar: 'تحديث على شروط الحجز الخاصة بكِ', title_en: 'An update to your booking terms',
      body_ar: 'يمكنكِ الاطلاع على التفاصيل وطلب المراجعة من حسابك.', body_en: 'You can see the details and request a review from your account.',
      target_path: APPEAL_PATH, dedupe_key: `policy.decision:${row.id}`,
    });
  }
  return row;
}

/** Ends an active decision (revoke or expire now). Caller authorises. */
export async function endDecision(trx: Tx, opts: { id: string; scope: 'tenant' | 'platform'; tenantId: string | null; kind: 'revoke' | 'expire'; reason: string; actorUserId: string | null; actor: AuditActor }) {
  let q = trx.selectFrom('policy_decisions').selectAll().where('id', '=', opts.id).where('scope', '=', opts.scope);
  q = opts.scope === 'tenant' ? q.where('tenant_id', '=', opts.tenantId!) : q.where('tenant_id', 'is', null);
  const cur = await q.forUpdate().executeTakeFirst();
  if (!cur) throw Errors.notFound('decision');
  if (cur.status !== 'active') throw Errors.conflict('decision_not_active', 'This decision is no longer active');
  const now = new Date();
  const status = opts.kind === 'revoke' ? 'revoked' : 'expired';
  const updated = await trx.updateTable('policy_decisions').set({
    status, ended_at: now, ended_by: opts.actorUserId, end_reason: opts.reason,
    ...(opts.kind === 'expire' && (!cur.expires_at || cur.expires_at > now) && cur.effective_at < now ? { expires_at: now } : {}),
  }).where('id', '=', cur.id).returningAll().executeTakeFirstOrThrow();
  await audit(trx, opts.actor, `policy_decision.${status}`, { tenantId: opts.tenantId, targetType: 'policy_decision', targetId: cur.id, data: { reason: opts.reason, action: cur.action } });
  return updated;
}

/** Shape for tenant members without incidents.review: the effect only. */
export function decisionEffect(d: { id: string; scope: string; action: string; status: string; effective_at: Date; expires_at: Date | null; review_at: Date | null; is_experimental: boolean }) {
  return { id: d.id, scope: d.scope, action: d.action, status: d.status, effective_at: d.effective_at, expires_at: d.expires_at, review_at: d.review_at, is_experimental: d.is_experimental };
}
