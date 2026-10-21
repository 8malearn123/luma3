import { sql } from 'kysely';
import type { z } from 'zod';
import { withSystem } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyUsers } from '../../infra/notify';
import type { SessionUser } from '../../auth/service';
import type {
  appealListQuery, appealResolve, decisionEnd, decisionListQuery, escalationDismiss, platformDecisionCreate, ruleCreate, rulePatch,
} from '@/shared/schemas/policy';
import { createDecision, endDecision } from './decisions';
import { offsetOf, page } from './paging';
import { createRule, listRules, suggestFor, updateRule } from './rules';

/**
 * LUMA platform policy review. Every function here is called only from
 * platform routes that require platform.policy.review (policy_reviewer or
 * platform_owner) and step-up for writes. Account suspension additionally
 * requires platform_owner. A business can never reach these functions: tenant
 * roles carry no platform capability and memberships cannot grant one.
 */

function isOwner(user: SessionUser) {
  return user.platformRoles.includes('platform_owner');
}

export async function listEscalations(status: 'pending' | 'decided' | 'dismissed' | 'all', cursor?: string, limit = 25) {
  return withSystem('platform policy: escalation queue', async (trx) => {
    const offset = offsetOf(cursor);
    let q = trx.selectFrom('customer_incidents as i')
      .innerJoin('tenants as t', 't.id', 'i.tenant_id')
      .leftJoin('users as u', 'u.id', 'i.customer_user_id')
      .leftJoin('bookings as b', (j) => j.onRef('b.id', '=', 'i.booking_id').onRef('b.tenant_id', '=', 'i.tenant_id'))
      .select(['i.id', 'i.tenant_id', 't.name as tenant_name', 'i.type', 'i.status', 'i.description', 'i.occurred_at', 'i.escalated_to_platform_at',
        'i.escalation_status', 'i.escalation_note', 'i.customer_user_id', 'u.display_name as customer_name', 'b.status as booking_status', 'b.starts_at as booking_starts_at',
        sql<number>`(select count(*)::int from incident_evidence e where e.incident_id = i.id)`.as('evidence_count')])
      .where('i.escalation_status', 'is not', null);
    if (status !== 'all') q = q.where('i.escalation_status', '=', status);
    const rows = await q.orderBy('i.escalated_to_platform_at', 'asc').orderBy('i.id').limit(limit + 1).offset(offset).execute();
    const p = page(rows, limit, offset);
    // Rule suggestions per customer (platform rules count escalated, confirmed incidents only).
    const items = [];
    for (const r of p.items) {
      items.push({ ...r, suggestions: r.customer_user_id ? await suggestFor(trx, { scope: 'platform', customerUserId: r.customer_user_id }) : [] });
    }
    return { ...p, items };
  });
}

export async function dismissEscalation(user: SessionUser, actor: AuditActor, incidentId: string, input: z.infer<typeof escalationDismiss>) {
  return withSystem('platform policy: dismiss escalation', async (trx) => {
    const i = await trx.selectFrom('customer_incidents').selectAll().where('id', '=', incidentId).where('escalation_status', 'is not', null).forUpdate().executeTakeFirst();
    if (!i) throw Errors.notFound('incident');
    if (i.escalation_status !== 'pending') throw Errors.conflict('already_decided', 'This escalation was already handled');
    await trx.updateTable('customer_incidents').set({ escalation_status: 'dismissed', platform_reviewed_by: user.userId, platform_reviewed_at: new Date() }).where('id', '=', i.id).execute();
    await trx.insertInto('incident_reviews').values({ tenant_id: i.tenant_id, incident_id: i.id, reviewer_id: user.userId, reviewer_scope: 'platform', from_status: i.status, to_status: i.status, note: `LUMA review: no platform action. ${input.note}` }).execute();
    await audit(trx, actor, 'incident.escalation_dismissed', { tenantId: null, targetType: 'incident', targetId: i.id });
    return { id: i.id, escalation_status: 'dismissed' };
  });
}

export async function listPlatformDecisions(q: z.infer<typeof decisionListQuery>) {
  return withSystem('platform policy: list decisions', async (trx) => {
    const offset = offsetOf(q.cursor);
    let query = trx.selectFrom('policy_decisions as d').leftJoin('users as u', 'u.id', 'd.customer_user_id').leftJoin('users as r', 'r.id', 'd.reviewer_id')
      .selectAll('d').select(['u.display_name as customer_name', 'r.display_name as reviewer_name'])
      .where('d.scope', '=', 'platform');
    if (q.status !== 'all') query = query.where('d.status', '=', q.status);
    if (q.customer_user_id) query = query.where('d.customer_user_id', '=', q.customer_user_id);
    if (q.action) query = query.where('d.action', '=', q.action);
    if (q.review_due === '1') query = query.where('d.review_flagged_at', 'is not', null).where('d.status', '=', 'active');
    const rows = await query.orderBy('d.created_at', 'desc').orderBy('d.id').limit(q.limit + 1).offset(offset).execute();
    return page(rows, q.limit, offset);
  });
}

export async function createPlatformDecision(user: SessionUser, actor: AuditActor, input: z.infer<typeof platformDecisionCreate>) {
  if (input.action === 'suspend_account' && !isOwner(user)) throw Errors.forbidden('Account suspension requires the LUMA platform owner', { reason: 'suspend_requires_owner' });
  return withSystem('platform policy: create decision', async (trx) => {
    if (input.supersedes_id) {
      const prev = await trx.selectFrom('policy_decisions').select('action').where('id', '=', input.supersedes_id).where('scope', '=', 'platform').executeTakeFirst();
      if (prev?.action === 'suspend_account' && !isOwner(user)) throw Errors.forbidden('Only the platform owner can change a suspension', { reason: 'suspend_requires_owner' });
    }
    let incident: { id: string; customer_user_id: string | null; escalation_status: string | null; tenant_id: string; status: string } | undefined;
    if (input.incident_id) {
      incident = await trx.selectFrom('customer_incidents').select(['id', 'customer_user_id', 'escalation_status', 'tenant_id', 'status'])
        .where('id', '=', input.incident_id).where('escalation_status', 'is not', null).forUpdate().executeTakeFirst();
      if (!incident) throw Errors.notFound('incident');
      if (incident.customer_user_id !== input.customer_user_id) throw Errors.invalid('incident_customer_mismatch');
    }
    const refs = [...input.evidence_refs];
    if (incident && !refs.some((r) => r.type === 'incident' && r.id === incident!.id)) refs.push({ type: 'incident', id: incident.id });
    const d = await createDecision(trx, {
      scope: 'platform', tenantId: null, customerUserId: input.customer_user_id, action: input.action, reason: input.reason,
      customerExplanationAr: input.customer_explanation_ar, customerExplanationEn: input.customer_explanation_en, evidenceRefs: refs,
      reviewerId: user.userId, effectiveAt: input.effective_at, expiresAt: input.expires_at, reviewAt: input.review_at,
      supersedesId: input.supersedes_id, ruleId: input.rule_id, isExperimental: input.is_experimental, sourceIncidentId: incident?.id ?? null, actor,
    });
    if (incident && incident.escalation_status === 'pending') {
      await trx.updateTable('customer_incidents').set({ escalation_status: 'decided', platform_reviewed_by: user.userId, platform_reviewed_at: new Date() }).where('id', '=', incident.id).execute();
      // The business learns that LUMA reviewed it — not the platform's reasoning.
      await trx.insertInto('incident_reviews').values({ tenant_id: incident.tenant_id, incident_id: incident.id, reviewer_id: user.userId, reviewer_scope: 'platform', from_status: incident.status, to_status: incident.status, note: 'LUMA review completed.' }).execute();
    }
    return d;
  });
}

export async function endPlatformDecision(user: SessionUser, actor: AuditActor, id: string, input: z.infer<typeof decisionEnd>) {
  return withSystem('platform policy: end decision', async (trx) => {
    const d = await trx.selectFrom('policy_decisions').select(['action']).where('id', '=', id).where('scope', '=', 'platform').executeTakeFirst();
    if (!d) throw Errors.notFound('decision');
    if (d.action === 'suspend_account' && !isOwner(user)) throw Errors.forbidden('Only the platform owner can change a suspension', { reason: 'suspend_requires_owner' });
    return endDecision(trx, { id, scope: 'platform', tenantId: null, kind: input.kind, reason: input.reason, actorUserId: user.userId, actor });
  });
}

export const listPlatformRules = () => withSystem('platform policy: rules', (trx) => listRules(trx, 'platform', null));
export const createPlatformRule = (actor: AuditActor, input: z.infer<typeof ruleCreate>) => withSystem('platform policy: create rule', (trx) => createRule(trx, 'platform', null, actor, input));
export const updatePlatformRule = (actor: AuditActor, id: string, input: z.infer<typeof rulePatch>) => withSystem('platform policy: update rule', (trx) => updateRule(trx, 'platform', null, actor, id, input));

export async function listPlatformAppeals(q: z.infer<typeof appealListQuery>) {
  return withSystem('platform policy: appeals', async (trx) => {
    const offset = offsetOf(q.cursor);
    let query = trx.selectFrom('appeals as a').leftJoin('users as u', 'u.id', 'a.customer_user_id').leftJoin('policy_decisions as d', 'd.id', 'a.decision_id')
      .select(['a.id', 'a.status', 'a.message', 'a.resolution_note', 'a.created_at', 'a.resolved_at', 'a.decision_id', 'a.customer_user_id',
        'u.display_name as customer_name', 'd.action as decision_action', 'd.status as decision_status', 'd.reason as decision_reason'])
      .where('a.review_scope', '=', 'platform');
    if (q.status === 'open') query = query.where('a.status', 'in', ['submitted', 'under_review']);
    else if (q.status !== 'all') query = query.where('a.status', '=', q.status);
    const rows = await query.orderBy('a.created_at', 'desc').orderBy('a.id').limit(q.limit + 1).offset(offset).execute();
    return page(rows, q.limit, offset);
  });
}

export async function resolvePlatformAppeal(user: SessionUser, actor: AuditActor, id: string, input: z.infer<typeof appealResolve>) {
  return withSystem('platform policy: resolve appeal', async (trx) => {
    const ap = await trx.selectFrom('appeals').selectAll().where('id', '=', id).where('review_scope', '=', 'platform').forUpdate().executeTakeFirst();
    if (!ap) throw Errors.notFound('appeal');
    if (ap.status !== 'submitted' && ap.status !== 'under_review') throw Errors.conflict('appeal_closed', 'This appeal was already resolved');
    if (input.outcome === 'under_review') {
      const row = await trx.updateTable('appeals').set({ status: 'under_review', reviewer_id: user.userId }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actor, 'appeal.under_review', { tenantId: null, targetType: 'appeal', targetId: id });
      return row;
    }
    const effects: Record<string, unknown> = {};
    if (input.outcome === 'accepted' && ap.decision_id) {
      const d = await trx.selectFrom('policy_decisions').selectAll().where('id', '=', ap.decision_id).where('scope', '=', 'platform').executeTakeFirst();
      if (d && d.status === 'active') {
        if (d.action === 'suspend_account' && !isOwner(user)) throw Errors.forbidden('Only the platform owner can change a suspension', { reason: 'suspend_requires_owner' });
        if (input.corrected_action && input.corrected_action !== d.action) {
          const nd = await createDecision(trx, {
            scope: 'platform', tenantId: null, customerUserId: d.customer_user_id, action: input.corrected_action, reason: `Corrected after appeal: ${input.resolution_note}`,
            reviewerId: user.userId, supersedesId: d.id, evidenceRefs: [{ type: 'note', note: `appeal ${ap.id}` }],
            expiresAt: d.expires_at && d.expires_at > new Date() ? d.expires_at : null, actor, silent: true,
          });
          effects.corrected_decision_id = nd.id;
        } else {
          await endDecision(trx, { id: d.id, scope: 'platform', tenantId: null, kind: 'revoke', reason: `appeal accepted: ${input.resolution_note}`, actorUserId: user.userId, actor });
          effects.revoked_decision_id = d.id;
        }
      }
    }
    const row = await trx.updateTable('appeals').set({ status: input.outcome, resolution_note: input.resolution_note, reviewer_id: user.userId, resolved_at: new Date() })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, `appeal.${input.outcome}`, { tenantId: null, targetType: 'appeal', targetId: id, data: effects });
    await notifyUsers(trx, null, [ap.customer_user_id], {
      kind: 'policy.appeal', title_ar: 'تم الرد على طلب المراجعة', title_en: 'Your review request was answered', target_path: '/account/policy', dedupe_key: `policy.appeal:${id}:${input.outcome}`,
    });
    return { ...row, effects };
  });
}

