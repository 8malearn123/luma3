import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import type { TenantAccess } from '../../tenancy/access';
import type { couponInput, couponPatch } from '@/shared/schemas/commerce';

/**
 * Coupons shared by bookings (appliesTo 'services') and orders ('products').
 *
 *  validateCoupon  — read-only check + discount computation (no locks).
 *  redeemCoupon    — locks the coupon row (FOR UPDATE), re-checks the global
 *                    and per-customer limits under that lock, records the
 *                    redemption and increments redemptions_count. Concurrent
 *                    redemptions serialize on the row lock; the DB CHECK
 *                    (redemptions_count <= max_redemptions) is the backstop.
 *  releaseCouponRedemption — exactly once (status 'applied' → 'released').
 *
 * Percent coupons store basis points (1500 = 15%); fixed coupons store minor units.
 */
type CouponRow = {
  id: string; code: string; kind: string; value: number; applies_to: string; min_subtotal_minor: number;
  max_redemptions: number | null; per_customer_limit: number; redemptions_count: number;
  starts_at: Date | null; ends_at: Date | null; is_active: boolean;
};

export function computeDiscount(c: Pick<CouponRow, 'kind' | 'value'>, subtotalMinor: number) {
  if (subtotalMinor <= 0) return 0;
  const d = c.kind === 'percent' ? Math.floor((subtotalMinor * c.value) / 10000) : c.value;
  return Math.max(0, Math.min(subtotalMinor, d));
}

function checkCoupon(c: CouponRow, ctx: { subtotalMinor: number; appliesTo: 'services' | 'products' }, now = new Date()) {
  if (!c.is_active) throw Errors.invalid('coupon_invalid', 'This code is not valid');
  if (c.starts_at && c.starts_at > now) throw Errors.invalid('coupon_not_started', 'This code is not active yet');
  if (c.ends_at && c.ends_at <= now) throw Errors.invalid('coupon_expired', 'This code has expired');
  if (c.applies_to !== 'all' && c.applies_to !== ctx.appliesTo) throw Errors.invalid('coupon_not_applicable', 'This code does not apply here');
  if (ctx.subtotalMinor < c.min_subtotal_minor) {
    throw Errors.invalid('coupon_min_subtotal', 'The order is below the minimum for this code', { min_subtotal_minor: c.min_subtotal_minor });
  }
  if (c.max_redemptions != null && c.redemptions_count >= c.max_redemptions) throw Errors.conflict('coupon_exhausted', 'This code has been fully used');
}

async function customerRedemptions(trx: Tx, tenantId: string, couponId: string, tenantCustomerId: string) {
  const r = await trx.selectFrom('coupon_redemptions').select(sql<number>`count(*)::int`.as('n'))
    .where('tenant_id', '=', tenantId).where('coupon_id', '=', couponId)
    .where('tenant_customer_id', '=', tenantCustomerId).where('status', '=', 'applied').executeTakeFirstOrThrow();
  return r.n;
}

export async function validateCoupon(
  trx: Tx, tenantId: string, code: string,
  ctx: { tenantCustomerId: string; subtotalMinor: number; appliesTo: 'services' | 'products' },
): Promise<{ couponId: string; discountMinor: number }> {
  const c = await trx.selectFrom('coupons').selectAll().where('tenant_id', '=', tenantId).where('code', '=', code.trim()).executeTakeFirst();
  if (!c) throw Errors.invalid('coupon_invalid', 'This code is not valid');
  const row = c as unknown as CouponRow;
  checkCoupon(row, ctx);
  if (await customerRedemptions(trx, tenantId, c.id, ctx.tenantCustomerId) >= c.per_customer_limit) {
    throw Errors.conflict('coupon_customer_limit', 'You have already used this code');
  }
  return { couponId: c.id, discountMinor: computeDiscount(row, ctx.subtotalMinor) };
}

export async function redeemCoupon(
  trx: Tx, tenantId: string, couponId: string,
  r: { tenantCustomerId: string; bookingId?: string; orderId?: string; discountMinor: number },
): Promise<{ redemptionId: string }> {
  if (!!r.bookingId === !!r.orderId) throw Errors.invalid('invalid_redemption', 'Exactly one of bookingId or orderId is required');
  const c = await trx.selectFrom('coupons').selectAll().where('tenant_id', '=', tenantId).where('id', '=', couponId).forUpdate().executeTakeFirst();
  if (!c) throw Errors.invalid('coupon_invalid', 'This code is not valid');
  if (!c.is_active) throw Errors.invalid('coupon_invalid', 'This code is not valid');
  if (c.ends_at && c.ends_at <= new Date()) throw Errors.invalid('coupon_expired', 'This code has expired');
  if (c.max_redemptions != null && c.redemptions_count >= c.max_redemptions) throw Errors.conflict('coupon_exhausted', 'This code has been fully used');
  if (await customerRedemptions(trx, tenantId, couponId, r.tenantCustomerId) >= c.per_customer_limit) {
    throw Errors.conflict('coupon_customer_limit', 'You have already used this code');
  }
  const row = await trx.insertInto('coupon_redemptions').values({
    tenant_id: tenantId, coupon_id: couponId, tenant_customer_id: r.tenantCustomerId,
    booking_id: r.bookingId ?? null, order_id: r.orderId ?? null, discount_minor: r.discountMinor,
  }).returning('id').executeTakeFirstOrThrow();
  await trx.updateTable('coupons').set({ redemptions_count: sql`redemptions_count + 1` }).where('id', '=', couponId).execute();
  return { redemptionId: row.id };
}

export async function releaseCouponRedemption(trx: Tx, tenantId: string, ref: { bookingId?: string; orderId?: string }): Promise<{ released: number }> {
  if (!ref.bookingId && !ref.orderId) return { released: 0 };
  let q = trx.updateTable('coupon_redemptions').set({ status: 'released' }).where('tenant_id', '=', tenantId).where('status', '=', 'applied');
  q = ref.bookingId ? q.where('booking_id', '=', ref.bookingId) : q.where('order_id', '=', ref.orderId!);
  const rows = await q.returning('coupon_id').execute();
  for (const r of rows) {
    await trx.updateTable('coupons').set({ redemptions_count: sql`greatest(redemptions_count - 1, 0)` }).where('id', '=', r.coupon_id).execute();
  }
  return { released: rows.length };
}

// ── Dashboard CRUD (catalog.edit) ───────────────────────────────────────────
export async function listCoupons(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('coupons').selectAll().where('tenant_id', '=', access.tenantId)
    .orderBy('is_active', 'desc').orderBy('created_at', 'desc').limit(500).execute());
}

export async function createCoupon(access: TenantAccess, actor: AuditActor, input: z.infer<typeof couponInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const exists = await trx.selectFrom('coupons').select('id').where('code', '=', input.code).executeTakeFirst();
    if (exists) throw Errors.conflict('coupon_code_taken', 'This code already exists');
    const row = await trx.insertInto('coupons').values({
      tenant_id: access.tenantId, code: input.code, kind: input.kind, value: input.value, applies_to: input.applies_to,
      min_subtotal_minor: input.min_subtotal_minor, max_redemptions: input.max_redemptions ?? null, per_customer_limit: input.per_customer_limit,
      starts_at: input.starts_at ? new Date(input.starts_at) : null, ends_at: input.ends_at ? new Date(input.ends_at) : null,
      is_active: input.is_active, source: 'manual',
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'coupon.created', { tenantId: access.tenantId, targetType: 'coupon', targetId: row.id, data: { code: input.code, kind: input.kind, value: input.value } });
    return row;
  });
}

/** Coupons are deactivated, never deleted (redemptions reference them). */
export async function updateCoupon(access: TenantAccess, actor: AuditActor, id: string, patch: z.infer<typeof couponPatch>) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('coupons').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('coupon');
    if (patch.max_redemptions != null && patch.max_redemptions < cur.redemptions_count) {
      throw Errors.invalid('coupon_limit_below_usage', 'The limit cannot be lower than the redemptions already made');
    }
    const row = await trx.updateTable('coupons').set({
      ...(patch.is_active !== undefined ? { is_active: patch.is_active } : {}),
      ...(patch.ends_at !== undefined ? { ends_at: patch.ends_at ? new Date(patch.ends_at) : null } : {}),
      ...(patch.max_redemptions !== undefined ? { max_redemptions: patch.max_redemptions } : {}),
      ...(patch.min_subtotal_minor !== undefined ? { min_subtotal_minor: patch.min_subtotal_minor } : {}),
      ...(patch.per_customer_limit !== undefined ? { per_customer_limit: patch.per_customer_limit } : {}),
    }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'coupon.updated', { tenantId: access.tenantId, targetType: 'coupon', targetId: id, data: patch });
    return row;
  });
}
