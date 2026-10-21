import { sql } from 'kysely';
import { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { idempotent, requestHash } from '../../infra/idempotency';
import { requireFeature, type TenantAccess } from '../../tenancy/access';
import { computeTotals } from '../booking/pricing';
import { post } from '../finance/journal';

/**
 * Memberships & prepaid packages (spec §24): included sessions per eligible
 * service, a validity period, entitlement RESERVATION when booked, CONSUMPTION
 * when delivered, RELEASE after an eligible cancellation. The DB enforces
 * used + reserved <= total; booking item reservations are unique.
 * Revenue: the price paid is a liability, recognised per delivered session
 * at (price paid ÷ total included sessions).
 */
export const planInput = z.object({
  name_ar: z.string().trim().max(120).optional(), name_en: z.string().trim().max(120).optional(),
  description_ar: z.string().trim().max(1000).optional(), description_en: z.string().trim().max(1000).optional(),
  price_minor: z.number().int().min(0).max(100_000_000), validity_days: z.number().int().min(1).max(1095),
  items: z.array(z.object({ service_id: z.string().uuid(), sessions: z.number().int().min(1).max(500) }).strict()).min(1).max(20),
  is_active: z.boolean().default(true), is_visible: z.boolean().default(true),
}).strict().refine((v) => v.name_ar || v.name_en, 'A name is required');

export async function createPlan(access: TenantAccess, actor: AuditActor, input: z.infer<typeof planInput>) {
  requireFeature(access, 'feature.memberships');
  return withTenant(access.tenantId, async (trx) => {
    const ids = input.items.map((i) => i.service_id);
    if (new Set(ids).size !== ids.length) throw Errors.invalid('duplicate_service');
    const svc = await trx.selectFrom('services').select('id').where('id', 'in', ids).where('archived_at', 'is', null).execute();
    if (svc.length !== ids.length) throw Errors.invalid('invalid_reference');
    const { items, ...fields } = input;
    const plan = await trx.insertInto('membership_plans').values({ tenant_id: access.tenantId, ...fields, name_ar: fields.name_ar ?? null, name_en: fields.name_en ?? null, description_ar: fields.description_ar ?? null, description_en: fields.description_en ?? null }).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto('membership_plan_items').values(items.map((i) => ({ tenant_id: access.tenantId, plan_id: plan.id, service_id: i.service_id, sessions: i.sessions }))).execute();
    await audit(trx, actor, 'membership.plan_created', { tenantId: access.tenantId, targetType: 'membership_plan', targetId: plan.id });
    return { ...plan, items };
  });
}

export async function listPlans(tenantId: string, publicOnly = false) {
  return withTenant(tenantId, async (trx) => {
    let q = trx.selectFrom('membership_plans').selectAll();
    if (publicOnly) q = q.where('is_active', '=', true).where('is_visible', '=', true);
    const plans = await q.orderBy('created_at').execute();
    const items = plans.length ? await trx.selectFrom('membership_plan_items').selectAll().where('plan_id', 'in', plans.map((p) => p.id)).execute() : [];
    return plans.map((p) => ({ ...p, items: items.filter((i) => i.plan_id === p.id).map((i) => ({ service_id: i.service_id, sessions: i.sessions })) }));
  });
}

/** Activates a membership once paid: entitlements are created from the plan snapshot (exactly once). */
export async function activateMembership(trx: Tx, tenantId: string, membershipId: string, paidMinor: number) {
  const m = await trx.selectFrom('customer_memberships').selectAll().where('id', '=', membershipId).forUpdate().executeTakeFirstOrThrow();
  if (m.status === 'active') return false;
  const snap = m.plan_snapshot as { validity_days: number; items: Array<{ service_id: string; sessions: number }> };
  const now = new Date();
  await trx.updateTable('customer_memberships').set({ status: 'active', starts_at: now, ends_at: new Date(now.getTime() + snap.validity_days * 86_400_000), price_paid_minor: paidMinor }).where('id', '=', membershipId).execute();
  await trx.insertInto('membership_entitlements').values(snap.items.map((i) => ({ tenant_id: tenantId, membership_id: membershipId, service_id: i.service_id, total: i.sessions })))
    .onConflict((oc) => oc.columns(['membership_id', 'service_id']).doNothing()).execute();
  return true;
}

/** Staff sells a membership with on-site payment (collector identity + reference). */
export async function sellMembership(access: TenantAccess, actor: AuditActor, input: { tenantCustomerId: string; planId: string; method: 'cash' | 'pos_terminal'; reference: string; idempotencyKey: string }) {
  requireFeature(access, 'feature.memberships');
  return withTenant(access.tenantId, (trx) => idempotent(trx, { scope: `tenant:${access.tenantId}`, operation: 'membership.sell', key: input.idempotencyKey, hash: requestHash(input) }, async () => {
    const plan = await trx.selectFrom('membership_plans').selectAll().where('id', '=', input.planId).where('is_active', '=', true).executeTakeFirst();
    if (!plan) throw Errors.notFound('membership_plan');
    const items = await trx.selectFrom('membership_plan_items').select(['service_id', 'sessions']).where('plan_id', '=', plan.id).execute();
    const m = await trx.insertInto('customer_memberships').values({
      tenant_id: access.tenantId, plan_id: plan.id, tenant_customer_id: input.tenantCustomerId, price_paid_minor: plan.price_minor,
      plan_snapshot: JSON.stringify({ name_ar: plan.name_ar, name_en: plan.name_en, price_minor: plan.price_minor, validity_days: plan.validity_days, items }),
    }).returning('id').executeTakeFirstOrThrow();
    if (plan.price_minor > 0) {
      await trx.insertInto('payments').values({
        tenant_id: access.tenantId, purpose: 'membership', customer_membership_id: m.id, kind: 'full', method: input.method, amount_minor: plan.price_minor, currency: 'SAR',
        status: 'captured', provider: 'on_site', idempotency_key: `membership:${input.idempotencyKey}`, collected_by: actor.userId, cash_reference: input.reference, captured_at: new Date(), created_by: actor.userId,
      }).execute();
      await post(trx, access.tenantId, { type: 'membership_sale', id: m.id }, [
        { account: input.method === 'cash' ? 'cash_on_hand' : 'provider_clearing', debit: plan.price_minor }, { account: 'membership_liability', credit: plan.price_minor },
      ], { createdBy: actor.userId });
    }
    await activateMembership(trx, access.tenantId, m.id, plan.price_minor);
    await audit(trx, actor, 'membership.sold', { tenantId: access.tenantId, targetType: 'customer_membership', targetId: m.id, data: { plan: plan.id, price_minor: plan.price_minor } });
    return { status: 201, body: { membership_id: m.id } };
  }));
}

export async function customerMemberships(tenantId: string, tenantCustomerId: string) {
  return withTenant(tenantId, async (trx) => {
    const ms = await trx.selectFrom('customer_memberships').selectAll().where('tenant_customer_id', '=', tenantCustomerId).orderBy('created_at', 'desc').execute();
    const ents = ms.length ? await trx.selectFrom('membership_entitlements').selectAll().where('membership_id', 'in', ms.map((m) => m.id)).execute() : [];
    return ms.map((m) => ({ ...m, entitlements: ents.filter((e) => e.membership_id === m.id).map((e) => ({ id: e.id, service_id: e.service_id, total: e.total, used: e.used, reserved: e.reserved, remaining: e.total - e.used - e.reserved })) }));
  });
}

/**
 * Applies active memberships to a HELD booking: each eligible item reserves one
 * session (atomic UPDATE guarded by the CHECK), and its price becomes a discount.
 * Totals are recomputed server-side; the customer re-checks out afterwards.
 */
export async function applyToBooking(tenantId: string, bookingId: string, userId: string) {
  return withTenant(tenantId, async (trx) => {
    const b = await trx.selectFrom('bookings').selectAll().where('id', '=', bookingId).forUpdate().executeTakeFirst();
    if (!b || b.customer_user_id !== userId) throw Errors.notFound('booking');
    if (b.status !== 'held') throw Errors.conflict('invalid_transition', `Booking is ${b.status}`);
    const items = await trx.selectFrom('booking_items').selectAll().where('booking_id', '=', bookingId).where('superseded_at', 'is', null).execute();
    let discount = b.discount_minor;
    const applied: string[] = [];
    for (const it of items) {
      const already = await trx.selectFrom('entitlement_reservations').select('id').where('booking_item_id', '=', it.id).executeTakeFirst();
      if (already) continue;
      const ent = await trx.selectFrom('membership_entitlements as e').innerJoin('customer_memberships as m', 'm.id', 'e.membership_id')
        .select(['e.id']).where('m.tenant_customer_id', '=', b.tenant_customer_id).where('m.status', '=', 'active').where('m.ends_at', '>', it.starts_at)
        .where('e.service_id', '=', it.service_id).where(sql<boolean>`e.used + e.reserved < e.total`).orderBy('m.ends_at').executeTakeFirst();
      if (!ent) continue;
      const upd = await trx.updateTable('membership_entitlements').set({ reserved: sql`reserved + 1` }).where('id', '=', ent.id).where(sql<boolean>`used + reserved < total`).returning('id').executeTakeFirst();
      if (!upd) continue;
      await trx.insertInto('entitlement_reservations').values({ tenant_id: tenantId, entitlement_id: ent.id, booking_item_id: it.id }).execute();
      discount += it.line_total_minor;
      applied.push(it.id);
    }
    if (!applied.length) throw Errors.invalid('no_eligible_membership', 'No active membership covers these services');
    const policy = b.policy_snapshot as { tax_rate_bp?: number; prices_include_tax?: boolean };
    const totals = computeTotals(b.subtotal_minor, discount, policy.tax_rate_bp ?? 0, policy.prices_include_tax ?? true);
    const terms = b.payment_terms as Record<string, unknown>;
    await trx.updateTable('bookings').set({
      discount_minor: totals.discount, tax_minor: totals.tax, total_minor: totals.total, deposit_due_minor: 0,
      payment_terms: JSON.stringify({ ...terms, amountDueMinor: totals.total, allowed: totals.total === 0 ? ['on_site'] : terms.allowed, depositMinor: null, membership_applied: applied.length }),
    }).where('id', '=', bookingId).execute();
    return { applied_items: applied.length, totals };
  });
}

/** Booking hook (completion): reserved sessions are consumed and their value recognised. */
export async function consumeForBooking(trx: Tx, tenantId: string, bookingId: string) {
  const rs = await trx.selectFrom('entitlement_reservations as r').innerJoin('booking_items as i', 'i.id', 'r.booking_item_id')
    .select(['r.id', 'r.entitlement_id']).where('i.booking_id', '=', bookingId).where('r.status', '=', 'reserved').execute();
  for (const r of rs) {
    const upd = await trx.updateTable('entitlement_reservations').set({ status: 'consumed' }).where('id', '=', r.id).where('status', '=', 'reserved').returning('id').executeTakeFirst();
    if (!upd) continue;
    await trx.updateTable('membership_entitlements').set({ reserved: sql`reserved - 1`, used: sql`used + 1` }).where('id', '=', r.entitlement_id).execute();
    const m = await trx.selectFrom('membership_entitlements as e').innerJoin('customer_memberships as m', 'm.id', 'e.membership_id')
      .select(['m.price_paid_minor', 'm.id', sql<number>`(select sum(total)::int from membership_entitlements x where x.membership_id = m.id)`.as('sessions')]).where('e.id', '=', r.entitlement_id).executeTakeFirstOrThrow();
    const value = m.sessions ? Math.round(m.price_paid_minor / m.sessions) : 0;
    if (value > 0) await post(trx, tenantId, { type: 'membership_session', id: r.id }, [{ account: 'membership_liability', debit: value }, { account: 'service_revenue', credit: value }], { memo: 'membership session delivered' });
  }
}

/** Booking hook (cancel/no-show/expiry): reservations are released (no-show consumes per policy: released here, documented). */
export async function releaseForBooking(trx: Tx, bookingId: string) {
  const rs = await trx.selectFrom('entitlement_reservations as r').innerJoin('booking_items as i', 'i.id', 'r.booking_item_id')
    .select(['r.id', 'r.entitlement_id']).where('i.booking_id', '=', bookingId).where('r.status', '=', 'reserved').execute();
  for (const r of rs) {
    const upd = await trx.updateTable('entitlement_reservations').set({ status: 'released' }).where('id', '=', r.id).where('status', '=', 'reserved').returning('id').executeTakeFirst();
    if (upd) await trx.updateTable('membership_entitlements').set({ reserved: sql`reserved - 1` }).where('id', '=', r.entitlement_id).execute();
  }
}
