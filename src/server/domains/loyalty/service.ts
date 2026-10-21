import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { withSystem, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { requireFeature, type TenantAccess } from '../../tenancy/access';

/**
 * Loyalty (spec §24): a points LEDGER (append-only points_entries) with a cached
 * balance updated in the same transaction; never an editable balance.
 * Scope: tenant-specific (platform-wide redemption is a separate product decision).
 *
 * Rules (configurable per business):
 *  - Earn: floor(paid amount in SAR × points_per_currency_unit) when a paid
 *    booking is completed or an order is collected — once per source.
 *  - Reverse: refunds reverse proportionally (if reverse_on_refund), never below zero.
 *  - Expiry: points expire after `points_expiry_days` of account INACTIVITY.
 *  - Redemption: points → single-use coupon; row lock prevents concurrent
 *    redemptions from exceeding the balance.
 */
export const programInput = z.object({
  is_enabled: z.boolean(),
  points_per_currency_unit: z.number().min(0).max(100),
  points_expiry_days: z.number().int().min(30).max(1825).nullable(),
  tiers: z.array(z.object({ code: z.string().regex(/^[a-z0-9_]{2,20}$/), name_ar: z.string().max(40), name_en: z.string().max(40), min_lifetime_points: z.number().int().min(0) }).strict()).max(6),
  reverse_on_refund: z.boolean(),
  version: z.number().int().min(1),
}).strict();

export const rewardInput = z.object({
  name_ar: z.string().trim().max(80).optional(), name_en: z.string().trim().max(80).optional(),
  points_cost: z.number().int().min(1).max(1_000_000), kind: z.enum(['fixed_discount', 'percent_discount']), value: z.number().int().min(1).max(10_000_000),
  is_active: z.boolean().default(true),
}).strict().refine((v) => v.name_ar || v.name_en, 'A name is required');

export async function getProgram(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => ({
    program: await trx.selectFrom('loyalty_programs').selectAll().where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow(),
    rewards: await trx.selectFrom('rewards').selectAll().orderBy('points_cost').execute(),
    stats: await trx.selectFrom('loyalty_accounts').select([sql<number>`count(*)::int`.as('accounts'), sql<number>`coalesce(sum(balance),0)::int`.as('outstanding_points')]).executeTakeFirstOrThrow(),
  }));
}

export async function updateProgram(access: TenantAccess, actor: AuditActor, input: z.infer<typeof programInput>) {
  requireFeature(access, 'feature.loyalty');
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('loyalty_programs').set({
      is_enabled: input.is_enabled, points_per_currency_unit: input.points_per_currency_unit, points_expiry_days: input.points_expiry_days,
      tiers: JSON.stringify(input.tiers), reverse_on_refund: input.reverse_on_refund, version: input.version + 1,
    }).where('tenant_id', '=', access.tenantId).where('version', '=', input.version).returningAll().executeTakeFirst();
    if (!r) throw Errors.versionConflict();
    await audit(trx, actor, 'loyalty.program_updated', { tenantId: access.tenantId, data: { enabled: input.is_enabled, rate: input.points_per_currency_unit } });
    return r;
  });
}

export async function createReward(access: TenantAccess, actor: AuditActor, input: z.infer<typeof rewardInput>) {
  requireFeature(access, 'feature.loyalty');
  if (input.kind === 'percent_discount' && input.value > 10000) throw Errors.invalid('invalid_value');
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.insertInto('rewards').values({ tenant_id: access.tenantId, ...input, name_ar: input.name_ar ?? null, name_en: input.name_en ?? null }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'loyalty.reward_created', { tenantId: access.tenantId, targetType: 'reward', targetId: r.id });
    return r;
  });
}

async function account(trx: Tx, tenantId: string, tenantCustomerId: string) {
  await trx.insertInto('loyalty_accounts').values({ tenant_id: tenantId, tenant_customer_id: tenantCustomerId })
    .onConflict((oc) => oc.columns(['tenant_id', 'tenant_customer_id']).doNothing()).execute();
  return trx.selectFrom('loyalty_accounts').selectAll().where('tenant_customer_id', '=', tenantCustomerId).forUpdate().executeTakeFirstOrThrow();
}

async function addEntry(trx: Tx, tenantId: string, acct: { id: string; balance: number; lifetime_earned: number }, e: { kind: 'earn' | 'redeem' | 'expire' | 'reverse' | 'adjust'; delta: number; refType: string; refId: string | null; reason?: string; by?: string | null }) {
  if (e.delta === 0) return null;
  const balance = acct.balance + e.delta;
  if (balance < 0) throw Errors.invalid('insufficient_points', 'Not enough points');
  const ins = await trx.insertInto('points_entries').values({
    tenant_id: tenantId, account_id: acct.id, kind: e.kind, delta: e.delta, balance_after: balance, ref_type: e.refType, ref_id: e.refId, reason: e.reason ?? null, created_by: e.by ?? null,
  }).onConflict((oc) => oc.columns(['account_id', 'kind', 'ref_type', 'ref_id']).where('ref_id', 'is not', null).doNothing()).returning('id').executeTakeFirst();
  if (!ins) return null; // already applied for this source
  await trx.updateTable('loyalty_accounts').set({
    balance, lifetime_earned: e.kind === 'earn' ? acct.lifetime_earned + e.delta : acct.lifetime_earned, last_activity_at: new Date(),
  }).where('id', '=', acct.id).execute();
  acct.balance = balance;
  if (e.kind === 'earn') acct.lifetime_earned += e.delta;
  return ins.id;
}

/** Booking hook (completion): earn on what was actually paid and kept. */
export async function earnForBooking(trx: Tx, tenantId: string, bookingId: string) {
  const prog = await trx.selectFrom('loyalty_programs').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!prog?.is_enabled) return;
  const b = await trx.selectFrom('bookings').select(['tenant_customer_id', 'paid_minor', 'refunded_minor']).where('id', '=', bookingId).executeTakeFirstOrThrow();
  const points = Math.floor(((b.paid_minor - b.refunded_minor) / 100) * Number(prog.points_per_currency_unit));
  if (points <= 0) return;
  const acct = await account(trx, tenantId, b.tenant_customer_id);
  await addEntry(trx, tenantId, acct, { kind: 'earn', delta: points, refType: 'booking', refId: bookingId });
}

/** Refund hook: proportional reversal of points earned from that booking, never below zero. */
export async function reverseForRefund(trx: Tx, tenantId: string, refundId: string) {
  const prog = await trx.selectFrom('loyalty_programs').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!prog?.is_enabled || !prog.reverse_on_refund) return;
  const r = await trx.selectFrom('refunds as r').innerJoin('payments as p', 'p.id', 'r.payment_id').select(['r.amount_minor', 'p.booking_id']).where('r.id', '=', refundId).executeTakeFirst();
  if (!r?.booking_id) return;
  const earned = await trx.selectFrom('points_entries as e').innerJoin('loyalty_accounts as a', 'a.id', 'e.account_id')
    .select(['e.delta', 'a.tenant_customer_id']).where('e.kind', '=', 'earn').where('e.ref_type', '=', 'booking').where('e.ref_id', '=', r.booking_id).executeTakeFirst();
  if (!earned) return;
  const due = Math.floor((r.amount_minor / 100) * Number(prog.points_per_currency_unit));
  const acct = await account(trx, tenantId, earned.tenant_customer_id);
  const amount = Math.min(due, earned.delta, acct.balance);
  if (amount > 0) await addEntry(trx, tenantId, acct, { kind: 'reverse', delta: -amount, refType: 'refund', refId: refundId, reason: due > amount ? `partial reversal (balance ${acct.balance})` : undefined });
}

/** Customer redeems a reward → single-use coupon. Concurrency-safe via the account row lock. */
export async function redeemReward(tenantId: string, tenantCustomerId: string, rewardId: string, idempotencyKey: string, actor: AuditActor) {
  return withTenant(tenantId, async (trx) => {
    const prior = await trx.selectFrom('reward_redemptions').select(['id', 'coupon_id']).where('idempotency_key', '=', idempotencyKey).executeTakeFirst();
    if (prior) {
      const c = await trx.selectFrom('coupons').select('code').where('id', '=', prior.coupon_id!).executeTakeFirstOrThrow();
      return { redemption_id: prior.id, code: c.code, replayed: true };
    }
    const prog = await trx.selectFrom('loyalty_programs').select('is_enabled').where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    if (!prog.is_enabled) throw Errors.invalid('loyalty_disabled');
    const reward = await trx.selectFrom('rewards').selectAll().where('id', '=', rewardId).where('is_active', '=', true).executeTakeFirst();
    if (!reward) throw Errors.notFound('reward');
    const acct = await account(trx, tenantId, tenantCustomerId);
    if (acct.balance < reward.points_cost) throw Errors.invalid('insufficient_points', 'Not enough points', { balance: acct.balance, needed: reward.points_cost });
    const code = `LUMA-${randomBytes(5).toString('hex').toUpperCase()}`;
    const coupon = await trx.insertInto('coupons').values({
      tenant_id: tenantId, code, kind: reward.kind === 'percent_discount' ? 'percent' : 'fixed', value: reward.value, max_redemptions: 1, per_customer_limit: 1,
      ends_at: new Date(Date.now() + 90 * 86_400_000), source: 'loyalty',
    }).returning('id').executeTakeFirstOrThrow();
    const red = await trx.insertInto('reward_redemptions').values({ tenant_id: tenantId, account_id: acct.id, reward_id: reward.id, points: reward.points_cost, coupon_id: coupon.id, idempotency_key: idempotencyKey })
      .returning('id').executeTakeFirstOrThrow();
    await addEntry(trx, tenantId, acct, { kind: 'redeem', delta: -reward.points_cost, refType: 'redemption', refId: red.id });
    await audit(trx, actor, 'loyalty.redeemed', { tenantId, targetType: 'reward_redemption', targetId: red.id, data: { points: reward.points_cost } });
    return { redemption_id: red.id, code, replayed: false };
  });
}

export async function adjustPoints(access: TenantAccess, actor: AuditActor, tenantCustomerId: string, delta: number, reason: string) {
  if (!reason || reason.length < 3) throw Errors.invalid('reason_required');
  return withTenant(access.tenantId, async (trx) => {
    const acct = await account(trx, access.tenantId, tenantCustomerId);
    const id = await addEntry(trx, access.tenantId, acct, { kind: 'adjust', delta, refType: 'manual', refId: null, reason, by: actor.userId });
    await audit(trx, actor, 'loyalty.adjusted', { tenantId: access.tenantId, targetType: 'tenant_customer', targetId: tenantCustomerId, data: { delta, reason } });
    return { entry_id: id, balance: acct.balance };
  });
}

export async function customerLoyalty(tenantId: string, tenantCustomerId: string) {
  return withTenant(tenantId, async (trx) => {
    const acct = await trx.selectFrom('loyalty_accounts').selectAll().where('tenant_customer_id', '=', tenantCustomerId).executeTakeFirst();
    const entries = acct ? await trx.selectFrom('points_entries').select(['kind', 'delta', 'balance_after', 'ref_type', 'created_at', 'reason']).where('account_id', '=', acct.id).orderBy('created_at', 'desc').limit(50).execute() : [];
    const prog = await trx.selectFrom('loyalty_programs').select(['tiers', 'is_enabled']).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    const tiers = (prog.tiers as Array<{ code: string; name_ar: string; name_en: string; min_lifetime_points: number }>) ?? [];
    const tier = [...tiers].sort((a, b) => b.min_lifetime_points - a.min_lifetime_points).find((t) => (acct?.lifetime_earned ?? 0) >= t.min_lifetime_points) ?? null;
    return { enabled: prog.is_enabled, balance: acct?.balance ?? 0, lifetime_earned: acct?.lifetime_earned ?? 0, tier, entries };
  });
}

/** Inactivity expiry: all points expire after `points_expiry_days` without activity (documented rule). */
export async function expireInactivePoints() {
  const due = await withSystem('find inactive loyalty accounts', (trx) => trx.selectFrom('loyalty_accounts as a').innerJoin('loyalty_programs as p', 'p.tenant_id', 'a.tenant_id')
    .select(['a.id', 'a.tenant_id', 'a.tenant_customer_id']).where('a.balance', '>', 0).where('p.points_expiry_days', 'is not', null)
    .where(sql<boolean>`a.last_activity_at < now() - make_interval(days => p.points_expiry_days)`).limit(500).execute());
  for (const d of due) {
    await withTenant(d.tenant_id, async (trx) => {
      const acct = await account(trx, d.tenant_id, d.tenant_customer_id);
      if (acct.balance > 0) await addEntry(trx, d.tenant_id, acct, { kind: 'expire', delta: -acct.balance, refType: 'inactivity', refId: null, reason: 'inactivity expiry' });
    });
  }
  return due.length;
}
