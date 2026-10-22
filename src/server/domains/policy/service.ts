import type { z } from 'zod';
import { withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyUsers } from '../../infra/notify';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import type { PaymentMethod } from '@/shared/payments';
import type {
  appealListQuery, appealResolve, auditQuery, decisionEnd, decisionListQuery, paymentTermsPreviewQuery, ruleCreate, rulePatch, tenantDecisionCreate,
} from '@/shared/schemas/policy';
import { createDecision, decisionEffect, endDecision } from './decisions';
import { revokeDecisionsFromIncident } from './incidents';
import { offsetOf, page } from './paging';
import { computePaymentTerms } from './payment-terms';
import { createRule, listRules, suggestFor, updateRule } from './rules';

// ── Tenant decisions ────────────────────────────────────────────────────────
export async function listTenantDecisions(access: TenantAccess, q: z.infer<typeof decisionListQuery>) {
  const full = hasCapability(access, 'incidents.review');
  return withTenant(access.tenantId, async (trx) => {
    const offset = offsetOf(q.cursor);
    let query = trx.selectFrom('policy_decisions as d')
      .innerJoin('tenant_customers as c', (j) => j.onRef('c.id', '=', 'd.tenant_customer_id').onRef('c.tenant_id', '=', 'd.tenant_id'))
      .leftJoin('users as r', 'r.id', 'd.reviewer_id')
      .selectAll('d').select(['c.display_name as customer_name', 'r.display_name as reviewer_name'])
      .where('d.tenant_id', '=', access.tenantId).where('d.scope', '=', 'tenant');
    if (q.status !== 'all') query = query.where('d.status', '=', q.status);
    if (q.tenant_customer_id) query = query.where('d.tenant_customer_id', '=', q.tenant_customer_id);
    if (q.action) query = query.where('d.action', '=', q.action);
    if (q.review_due === '1') query = query.where('d.review_flagged_at', 'is not', null).where('d.status', '=', 'active');
    const rows = await query.orderBy('d.created_at', 'desc').orderBy('d.id').limit(q.limit + 1).offset(offset).execute();
    const p = page(rows, q.limit, offset);
    return { ...p, items: p.items.map((d) => (full ? d : { ...decisionEffect(d), customer_name: d.customer_name, tenant_customer_id: d.tenant_customer_id })) };
  });
}

export async function getTenantDecision(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const d = await trx.selectFrom('policy_decisions as d')
      .innerJoin('tenant_customers as c', (j) => j.onRef('c.id', '=', 'd.tenant_customer_id').onRef('c.tenant_id', '=', 'd.tenant_id'))
      .leftJoin('users as r', 'r.id', 'd.reviewer_id')
      .selectAll('d').select(['c.display_name as customer_name', 'r.display_name as reviewer_name'])
      .where('d.tenant_id', '=', access.tenantId).where('d.scope', '=', 'tenant').where('d.id', '=', id).executeTakeFirst();
    if (!d) throw Errors.notFound('decision');
    const chain = await trx.selectFrom('policy_decisions').select(['id', 'action', 'status', 'effective_at', 'ended_at', 'supersedes_id'])
      .where('tenant_id', '=', access.tenantId).where('tenant_customer_id', '=', d.tenant_customer_id!).orderBy('created_at', 'desc').limit(20).execute();
    return { ...d, history: chain };
  });
}

export async function createTenantDecision(access: TenantAccess, actor: AuditActor, input: z.infer<typeof tenantDecisionCreate>) {
  return withTenant(access.tenantId, (trx) => createDecision(trx, {
    scope: 'tenant', tenantId: access.tenantId, tenantCustomerId: input.tenant_customer_id, action: input.action, reason: input.reason,
    customerExplanationAr: input.customer_explanation_ar, customerExplanationEn: input.customer_explanation_en, evidenceRefs: input.evidence_refs,
    reviewerId: actor.userId!, effectiveAt: input.effective_at, expiresAt: input.expires_at, reviewAt: input.review_at, supersedesId: input.supersedes_id,
    ruleId: input.rule_id, isExperimental: input.is_experimental,
    sourceIncidentId: input.evidence_refs.find((r) => r.type === 'incident')?.id ?? null, actor,
  }));
}

export async function endTenantDecision(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof decisionEnd>) {
  return withTenant(access.tenantId, (trx) => endDecision(trx, { id, scope: 'tenant', tenantId: access.tenantId, kind: input.kind, reason: input.reason, actorUserId: actor.userId, actor }));
}

// ── Rules & suggestions ─────────────────────────────────────────────────────
export const listTenantRules = (access: TenantAccess) => withTenant(access.tenantId, (trx) => listRules(trx, 'tenant', access.tenantId));
export const createTenantRule = (access: TenantAccess, actor: AuditActor, input: z.infer<typeof ruleCreate>) =>
  withTenant(access.tenantId, (trx) => createRule(trx, 'tenant', access.tenantId, actor, input));
export const updateTenantRule = (access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof rulePatch>) =>
  withTenant(access.tenantId, (trx) => updateRule(trx, 'tenant', access.tenantId, actor, id, input));

export async function tenantSuggestions(access: TenantAccess, tenantCustomerId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const tc = await trx.selectFrom('tenant_customers').select('id').where('tenant_id', '=', access.tenantId).where('id', '=', tenantCustomerId).executeTakeFirst();
    if (!tc) throw Errors.notFound('customer');
    return { suggestions: await suggestFor(trx, { scope: 'tenant', tenantId: access.tenantId, tenantCustomerId }), note: 'suggestions_only' };
  });
}

// ── Payment-terms preview (what checkout would offer) ───────────────────────
/**
 * Preview only: approximates the business's methods as the union of active
 * payment accounts' verified methods, plus cash when paying on site is enabled.
 * Real checkout passes the methods the payments domain resolved.
 */
export async function previewTerms(access: TenantAccess, q: z.infer<typeof paymentTermsPreviewQuery>) {
  return withTenant(access.tenantId, async (trx) => {
    const accounts = await trx.selectFrom('payment_accounts').select('enabled_methods').where('tenant_id', '=', access.tenantId).where('status', '=', 'active').execute();
    const s = await trx.selectFrom('tenant_settings').select('allow_pay_on_site').where('tenant_id', '=', access.tenantId).executeTakeFirst();
    const methods = new Set<PaymentMethod>(accounts.flatMap((a) => a.enabled_methods as PaymentMethod[]));
    if (s?.allow_pay_on_site) methods.add('cash');
    const terms = await computePaymentTerms(trx, {
      tenantId: access.tenantId, tenantCustomerId: q.tenant_customer_id, customerUserId: null, amountDueMinor: q.amount_minor, availableMethods: [...methods], context: q.context,
    });
    return { terms, assumed_methods: [...methods] };
  });
}

// ── Appeals inbox (tenant-scope items only) ─────────────────────────────────
export async function listTenantAppeals(access: TenantAccess, q: z.infer<typeof appealListQuery>) {
  return withTenant(access.tenantId, async (trx) => {
    const offset = offsetOf(q.cursor);
    let query = trx.selectFrom('appeals as a')
      .leftJoin('tenant_customers as c', (j) => j.onRef('c.user_id', '=', 'a.customer_user_id').onRef('c.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('policy_decisions as d', 'd.id', 'a.decision_id')
      .leftJoin('customer_incidents as i', 'i.id', 'a.incident_id')
      .select(['a.id', 'a.status', 'a.message', 'a.resolution_note', 'a.created_at', 'a.resolved_at', 'a.decision_id', 'a.incident_id',
        'c.id as tenant_customer_id', 'c.display_name as customer_name', 'd.action as decision_action', 'd.status as decision_status',
        'i.type as incident_type', 'i.status as incident_status', 'i.occurred_at as incident_occurred_at'])
      .where('a.tenant_id', '=', access.tenantId).where('a.review_scope', '=', 'tenant');
    if (q.status === 'open') query = query.where('a.status', 'in', ['submitted', 'under_review']);
    else if (q.status !== 'all') query = query.where('a.status', '=', q.status);
    const rows = await query.orderBy('a.created_at', 'desc').orderBy('a.id').limit(q.limit + 1).offset(offset).execute();
    return page(rows, q.limit, offset);
  });
}

/**
 * Resolves a tenant-scope appeal. Accepting an appeal on a decision revokes it
 * (or supersedes it with a milder corrected action); accepting an appeal on an
 * incident rejects the incident and revokes decisions based on it.
 */
export async function resolveTenantAppeal(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof appealResolve>) {
  return withTenant(access.tenantId, async (trx) => {
    const ap = await trx.selectFrom('appeals').selectAll().where('tenant_id', '=', access.tenantId).where('review_scope', '=', 'tenant').where('id', '=', id).forUpdate().executeTakeFirst();
    if (!ap) throw Errors.notFound('appeal');
    if (ap.status !== 'submitted' && ap.status !== 'under_review') throw Errors.conflict('appeal_closed', 'This appeal was already resolved');
    if (input.outcome === 'under_review') {
      const row = await trx.updateTable('appeals').set({ status: 'under_review', reviewer_id: actor.userId }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actor, 'appeal.under_review', { tenantId: access.tenantId, targetType: 'appeal', targetId: id });
      return row;
    }
    const effects: Record<string, unknown> = {};
    if (input.outcome === 'accepted') {
      if (ap.decision_id) {
        const d = await trx.selectFrom('policy_decisions').selectAll().where('id', '=', ap.decision_id).where('tenant_id', '=', access.tenantId).executeTakeFirst();
        if (d && d.status === 'active') {
          if (input.corrected_action && input.corrected_action !== d.action) {
            const nd = await createDecision(trx, {
              scope: 'tenant', tenantId: access.tenantId, tenantCustomerId: d.tenant_customer_id, action: input.corrected_action,
              reason: `Corrected after appeal: ${input.resolution_note}`, reviewerId: actor.userId!, supersedesId: d.id,
              evidenceRefs: [{ type: 'note', note: `appeal ${ap.id}` }], expiresAt: d.expires_at && d.expires_at > new Date() ? d.expires_at : null, actor, silent: true,
            });
            effects.corrected_decision_id = nd.id;
          } else {
            await endDecision(trx, { id: d.id, scope: 'tenant', tenantId: access.tenantId, kind: 'revoke', reason: `appeal accepted: ${input.resolution_note}`, actorUserId: actor.userId, actor });
            effects.revoked_decision_id = d.id;
          }
        }
      }
      if (ap.incident_id) {
        const inc = await trx.selectFrom('customer_incidents').select(['id', 'status', 'escalation_status']).where('id', '=', ap.incident_id).where('tenant_id', '=', access.tenantId).forUpdate().executeTakeFirst();
        if (inc && inc.status !== 'rejected') {
          await trx.updateTable('customer_incidents').set({ status: 'rejected', ...(inc.escalation_status === 'pending' ? { escalation_status: 'dismissed' } : {}) }).where('id', '=', inc.id).execute();
          await trx.insertInto('incident_reviews').values({ tenant_id: access.tenantId, incident_id: inc.id, reviewer_id: actor.userId!, reviewer_scope: 'tenant', from_status: inc.status, to_status: 'rejected', note: `Appeal accepted: ${input.resolution_note}` }).execute();
          await audit(trx, actor, 'incident.rejected', { tenantId: access.tenantId, targetType: 'incident', targetId: inc.id, data: { via_appeal: ap.id } });
          effects.revoked_decisions = await revokeDecisionsFromIncident(trx, access.tenantId, inc.id, actor, 'incident overturned on appeal');
        }
      }
    }
    const row = await trx.updateTable('appeals').set({ status: input.outcome, resolution_note: input.resolution_note, reviewer_id: actor.userId, resolved_at: new Date() })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, `appeal.${input.outcome}`, { tenantId: access.tenantId, targetType: 'appeal', targetId: id, data: effects });
    await notifyUsers(trx, access.tenantId, [ap.customer_user_id], {
      kind: 'policy.appeal', title_ar: 'تم الرد على طلب المراجعة', title_en: 'Your review request was answered',
      target_path: '/account/policy', dedupe_key: `policy.appeal:${id}:${input.outcome}`,
    });
    return { ...row, effects };
  });
}

// ── Audit trail for one policy record ───────────────────────────────────────
export async function policyAuditTrail(access: TenantAccess, q: z.infer<typeof auditQuery>) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('audit_logs as a').leftJoin('users as u', 'u.id', 'a.actor_user_id')
      .select(['a.id', 'a.action', 'a.actor_kind', 'a.created_at', 'a.data', 'u.display_name as actor_name'])
      .where('a.tenant_id', '=', access.tenantId).where('a.target_type', '=', q.target_type).where('a.target_id', '=', q.target_id)
      .orderBy('a.created_at', 'asc').limit(200).execute();
    // Platform reviewers act with tenant_id NULL, so their entries never appear here.
    return rows;
  });
}
