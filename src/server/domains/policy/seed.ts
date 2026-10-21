import type { Tx } from '../../db/client';
import type { IncidentStatus, IncidentType } from '@/shared/schemas/policy';
import { createDecision, type CreateDecisionArgs } from './decisions';

/**
 * Helpers for the seed script (and tests). They write the same rows the
 * services write, without HTTP/step-up, so call them only from trusted
 * scripts. Examples:
 *
 *   // an explicitly experimental require_full decision
 *   await withTenant(tid, (trx) => createDecision(trx, { scope: 'tenant', tenantId: tid, tenantCustomerId, action: 'require_full_payment',
 *     reason: 'Seed: two confirmed no-shows (experimental criterion)', isExperimental: true, reviewerId: ownerId, actor: SEED_ACTOR }));
 *   // an incident under review
 *   await withTenant(tid, (trx) => seedIncident(trx, { tenantId: tid, tenantCustomerId, bookingId, type: 'no_show', status: 'under_review', submittedBy, reviewerId }));
 *   // an appeal (system scope: appeals may be platform-level)
 *   await withSystem('seed appeal', (trx) => seedAppeal(trx, { customerUserId, decisionId, message: 'I had a medical emergency that day.' }));
 */
export const SEED_ACTOR = { userId: null, kind: 'system' as const };
export { createDecision, type CreateDecisionArgs };

export async function seedIncident(trx: Tx, v: {
  tenantId: string; tenantCustomerId: string; bookingId?: string | null; customerUserId?: string | null; type: IncidentType;
  description?: string; occurredAt?: Date; submittedBy: string; status?: IncidentStatus; reviewerId?: string; note?: string;
}) {
  const status = v.status ?? 'submitted';
  let customerUserId = v.customerUserId ?? null;
  if (!customerUserId) {
    const tc = await trx.selectFrom('tenant_customers').select('user_id').where('tenant_id', '=', v.tenantId).where('id', '=', v.tenantCustomerId).executeTakeFirstOrThrow();
    customerUserId = tc.user_id;
  }
  const row = await trx.insertInto('customer_incidents').values({
    tenant_id: v.tenantId, booking_id: v.bookingId ?? null, tenant_customer_id: v.tenantCustomerId, customer_user_id: customerUserId,
    type: v.type, description: v.description ?? 'Seed: the customer did not attend the appointment.', occurred_at: v.occurredAt ?? new Date(),
    submitted_by: v.submittedBy, status,
  }).returningAll().executeTakeFirstOrThrow();
  if (status !== 'submitted') {
    await trx.insertInto('incident_reviews').values({
      tenant_id: v.tenantId, incident_id: row.id, reviewer_id: v.reviewerId ?? v.submittedBy, reviewer_scope: 'tenant',
      from_status: 'submitted', to_status: status, note: v.note ?? 'Seed review note',
    }).execute();
  }
  return row;
}

/** Must run in system scope (withSystem) because platform-scope appeals have no tenant. */
export async function seedAppeal(trx: Tx, v: { customerUserId: string; decisionId?: string; incidentId?: string; message: string; status?: 'submitted' | 'under_review' }) {
  let tenantId: string | null = null;
  let scope: 'tenant' | 'platform' = 'tenant';
  if (v.decisionId) {
    const d = await trx.selectFrom('policy_decisions').select(['tenant_id', 'scope']).where('id', '=', v.decisionId).executeTakeFirstOrThrow();
    tenantId = d.tenant_id; scope = d.scope as 'tenant' | 'platform';
  } else if (v.incidentId) {
    const i = await trx.selectFrom('customer_incidents').select(['tenant_id']).where('id', '=', v.incidentId).executeTakeFirstOrThrow();
    tenantId = i.tenant_id;
  } else throw new Error('seedAppeal needs decisionId or incidentId');
  return trx.insertInto('appeals').values({
    customer_user_id: v.customerUserId, decision_id: v.decisionId ?? null, incident_id: v.incidentId ?? null,
    tenant_id: scope === 'tenant' ? tenantId : null, review_scope: scope, message: v.message, status: v.status ?? 'submitted',
  }).returningAll().executeTakeFirstOrThrow();
}
