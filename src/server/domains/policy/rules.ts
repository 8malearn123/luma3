import { sql } from 'kysely';
import type { z } from 'zod';
import type { Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import type { ruleCreate, ruleCriteria, rulePatch } from '@/shared/schemas/policy';

/**
 * Configurable criteria. Rules never decide: they only produce SUGGESTIONS for
 * an authorised human reviewer. No threshold ships as an approved value; rules
 * are experimental by default and labelled as such everywhere.
 */
type Criteria = z.infer<typeof ruleCriteria>;

export type RuleSuggestion = {
  rule_id: string;
  key: string;
  suggested_action: string;
  matched_incidents: number;
  criteria: Criteria;
  is_experimental: boolean;
};

export async function listRules(trx: Tx, scope: 'tenant' | 'platform', tenantId: string | null) {
  let q = trx.selectFrom('policy_rules').selectAll().where('scope', '=', scope);
  q = scope === 'tenant' ? q.where('tenant_id', '=', tenantId!) : q.where('tenant_id', 'is', null);
  return q.orderBy('created_at', 'desc').execute();
}

export async function createRule(trx: Tx, scope: 'tenant' | 'platform', tenantId: string | null, actor: AuditActor, input: z.infer<typeof ruleCreate>) {
  const row = await trx.insertInto('policy_rules').values({
    scope, tenant_id: scope === 'tenant' ? tenantId : null, key: input.key, description: input.description ?? null,
    criteria: JSON.stringify(input.criteria), suggested_action: input.suggested_action, is_enabled: input.is_enabled,
    is_experimental: input.is_experimental, created_by: actor.userId, updated_by: actor.userId,
  }).returningAll().executeTakeFirstOrThrow();
  await audit(trx, actor, 'policy_rule.created', { tenantId: scope === 'tenant' ? tenantId : null, targetType: 'policy_rule', targetId: row.id, data: { key: input.key, criteria: input.criteria, suggested_action: input.suggested_action, experimental: input.is_experimental } });
  return row;
}

export async function updateRule(trx: Tx, scope: 'tenant' | 'platform', tenantId: string | null, actor: AuditActor, id: string, patch: z.infer<typeof rulePatch>) {
  let q = trx.selectFrom('policy_rules').selectAll().where('id', '=', id).where('scope', '=', scope);
  q = scope === 'tenant' ? q.where('tenant_id', '=', tenantId!) : q.where('tenant_id', 'is', null);
  const cur = await q.forUpdate().executeTakeFirst();
  if (!cur) throw Errors.notFound('rule');
  if (cur.version !== patch.version) throw Errors.versionConflict(cur.version);
  const row = await trx.updateTable('policy_rules').set({
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.criteria ? { criteria: JSON.stringify(patch.criteria) } : {}),
    ...(patch.suggested_action ? { suggested_action: patch.suggested_action } : {}),
    ...(patch.is_enabled !== undefined ? { is_enabled: patch.is_enabled } : {}),
    ...(patch.is_experimental !== undefined ? { is_experimental: patch.is_experimental } : {}),
    version: cur.version + 1, updated_by: actor.userId,
  }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  await audit(trx, actor, 'policy_rule.updated', { tenantId: scope === 'tenant' ? tenantId : null, targetType: 'policy_rule', targetId: id, data: { fields: Object.keys(patch).filter((k) => k !== 'version') } });
  return row;
}

/**
 * Evaluates enabled rules for one customer. Tenant scope counts this business's
 * confirmed incidents; platform scope counts confirmed incidents that businesses
 * explicitly escalated (system scope only). Returns suggestions; writes nothing.
 */
export async function suggestFor(trx: Tx, target: { scope: 'tenant'; tenantId: string; tenantCustomerId: string } | { scope: 'platform'; customerUserId: string }, now = new Date()): Promise<RuleSuggestion[]> {
  const rules = (await listRules(trx, target.scope, target.scope === 'tenant' ? target.tenantId : null)).filter((r) => r.is_enabled);
  const out: RuleSuggestion[] = [];
  for (const r of rules) {
    const c = r.criteria as Criteria;
    const since = new Date(now.getTime() - c.window_days * 86_400_000);
    let q = trx.selectFrom('customer_incidents').select(sql<number>`count(*)::int`.as('n'))
      .where('status', 'in', ['confirmed', 'corrected']).where('occurred_at', '>=', since);
    if (c.incident_type) q = q.where('type', '=', c.incident_type);
    q = target.scope === 'tenant'
      ? q.where('tenant_id', '=', target.tenantId).where('tenant_customer_id', '=', target.tenantCustomerId)
      : q.where('customer_user_id', '=', target.customerUserId).where('escalation_status', 'is not', null);
    const { n } = await q.executeTakeFirstOrThrow();
    if (n >= c.min_confirmed) {
      out.push({ rule_id: r.id, key: r.key, suggested_action: r.suggested_action, matched_incidents: n, criteria: c, is_experimental: r.is_experimental });
    }
  }
  return out;
}
