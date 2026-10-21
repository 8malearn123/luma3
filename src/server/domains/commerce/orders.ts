import { sql } from 'kysely';
import type { z } from 'zod';
import { withSystem, withTenant, type Tx } from '../../db/client';
import { AppError, Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { nextReadableNumber } from '../../infra/counters';
import { idempotent, requestHash } from '../../infra/idempotency';
import { notifyCapability, notifyUsers } from '../../infra/notify';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { ensureTenantCustomerForUser } from '../customers/relationship';
import { cartLinesForOrder, lockCustomerCart, type CartIdentity } from './cart';
import { redeemCoupon, releaseCouponRedemption, validateCoupon } from './coupons';
import { moveStock, primaryBranchId, tenantSlug } from './stock';
import type { CheckoutInput, orderListQuery, returnInput } from '@/shared/schemas/commerce';

/**
 * Orders. Lifecycle: pending_payment → paid → preparing → ready → collected,
 * or → cancelled (customer/business/expiry). Refund status is separate and
 * owned by payments. Orders and bookings are separate records; an order may be
 * collected with a visit (fulfillment_method 'with_visit', booking_id).
 *
 * Stock: creation reserves (reserved += q) atomically per line; payment turns
 * each active reservation into a 'sale' (on_hand -= q, reserved -= q) exactly
 * once; cancellation/expiry releases active reservations exactly once
 * (reservation status guard + unique movement index). Collecting never touches
 * stock again.
 */
export const ORDER_PAYMENT_TTL_MIN = 30;

export type OrderSummary = {
  id: string; number: string; status: string; subtotal_minor: number; discount_minor: number; total_minor: number;
  currency: string; expires_at: string | null; checkout_path: string;
};

type Customer = { userId: string; displayName: string; phone: string | null; email: string | null };

async function event(trx: Tx, tenantId: string, orderId: string, e: { kind: string; from?: string | null; to?: string | null; reason?: string | null; data?: Record<string, unknown>; actorUserId?: string | null }) {
  await trx.insertInto('order_events').values({
    tenant_id: tenantId, order_id: orderId, kind: e.kind, from_status: e.from ?? null, to_status: e.to ?? null,
    reason: e.reason ?? null, data: JSON.stringify(e.data ?? {}), actor_user_id: e.actorUserId ?? null,
  }).execute();
}

// ── Creation ────────────────────────────────────────────────────────────────
/**
 * Creates a pending_payment order from the signed-in customer's open cart.
 * Re-reads price, stock, limits and coupon on the server; reserves stock in
 * the same transaction; idempotent per (tenant, user, Idempotency-Key).
 */
export async function createOrderFromCart(args: {
  tenantId: string;
  user: Customer;
  input: CheckoutInput;
  idempotencyKey: string;
  actor: AuditActor;
  /** Anonymous cart token from the browser, merged before checkout. */
  anonToken?: string | null;
}): Promise<{ order: OrderSummary; replayed: boolean }> {
  const { tenantId, user, input } = args;
  return withTenant(tenantId, async (trx) => {
    const r = await idempotent<OrderSummary>(trx, {
      scope: `t:${tenantId}:u:${user.userId}`, operation: 'order.create_from_cart', key: args.idempotencyKey, hash: requestHash(input),
    }, async () => ({ status: 201, body: await createOrderTx(trx, tenantId, user, input, args.actor, args.anonToken ?? null) }));
    return { order: r.body, replayed: r.replayed };
  });
}

async function createOrderTx(trx: Tx, tenantId: string, user: Customer, input: CheckoutInput, actor: AuditActor, anonToken: string | null): Promise<OrderSummary> {
  const ident: CartIdentity = { userId: user.userId, anonToken };
  const cartId = await lockCustomerCart(trx, tenantId, ident);
  const lines = cartId ? await cartLinesForOrder(trx, tenantId, cartId) : [];
  if (!lines.length) throw Errors.invalid('cart_empty', 'Your cart is empty');

  const unavailable = lines.filter((l) => l.problems.includes('unavailable'));
  if (unavailable.length) throw Errors.invalid('product_unavailable', 'Some products are no longer available', { variant_ids: unavailable.map((l) => l.variant_id) });
  const over = lines.filter((l) => l.problems.includes('exceeds_max_per_order'));
  if (over.length) throw Errors.invalid('max_per_order_exceeded', 'A product exceeds the per-order limit', { variant_ids: over.map((l) => l.variant_id) });
  const changed = lines.filter((l) => l.price_changed);
  if (changed.length) {
    throw Errors.conflict('prices_changed', 'Some prices changed since you added them. Review the cart to continue.', {
      items: changed.map((l) => ({ variant_id: l.variant_id, from_minor: l.added_unit_price_minor, to_minor: l.unit_price_minor })),
    });
  }
  const short = lines.filter((l) => l.problems.includes('out_of_stock') || l.problems.includes('insufficient_stock'));
  if (short.length) throw Errors.conflict('out_of_stock', 'Some products are out of stock', { variant_ids: short.map((l) => l.variant_id) });

  const tenantCustomerId = await ensureTenantCustomerForUser(trx, tenantId, user, 'storefront');
  let bookingId: string | null = null;
  if (input.fulfillment_method === 'with_visit') {
    const b = await trx.selectFrom('bookings').select(['id', 'status']).where('id', '=', input.booking_id!).where('tenant_customer_id', '=', tenantCustomerId).executeTakeFirst();
    if (!b || !['held', 'pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'in_service'].includes(b.status)) {
      throw Errors.invalid('invalid_booking', 'Choose one of your upcoming visits');
    }
    bookingId = b.id;
  }

  const subtotal = lines.reduce((a, l) => a + l.line_total_minor, 0);
  let coupon: { couponId: string; discountMinor: number } | null = null;
  if (input.coupon_code) coupon = await validateCoupon(trx, tenantId, input.coupon_code, { tenantCustomerId, subtotalMinor: subtotal, appliesTo: 'products' });
  const discount = coupon?.discountMinor ?? 0;
  const total = subtotal - discount;
  const t = await trx.selectFrom('tenants').select(['currency', 'slug']).where('id', '=', tenantId).executeTakeFirstOrThrow();
  const branchId = await primaryBranchId(trx, tenantId);
  const number = await nextReadableNumber(trx, tenantId, 'order');
  const expiresAt = new Date(Date.now() + ORDER_PAYMENT_TTL_MIN * 60_000);

  const order = await trx.insertInto('orders').values({
    tenant_id: tenantId, branch_id: branchId, number, tenant_customer_id: tenantCustomerId, customer_user_id: user.userId,
    status: 'pending_payment', fulfillment_method: input.fulfillment_method, booking_id: bookingId,
    subtotal_minor: subtotal, discount_minor: discount, total_minor: total, currency: t.currency,
    coupon_id: coupon?.couponId ?? null, expires_at: expiresAt, customer_note: input.note ?? null, created_by: user.userId,
  }).returning(['id']).executeTakeFirstOrThrow();

  const items = await trx.insertInto('order_items').values(lines.map((l) => ({
    tenant_id: tenantId, order_id: order.id, product_id: l.product_id, variant_id: l.variant_id,
    name_ar: l.name_ar, name_en: l.name_en, variant_name_ar: l.variant_name_ar, variant_name_en: l.variant_name_en, sku: l.sku,
    unit_price_minor: l.unit_price_minor, quantity: l.quantity, line_total_minor: l.line_total_minor,
    unit_cost_minor: l.unit_cost_minor, returnable: l.returnable,
  }))).returning(['id', 'variant_id', 'quantity']).execute();

  // Reserve in a stable lock order (inventory item id) to avoid deadlocks between concurrent orders.
  const toReserve = items.map((i) => ({ ...i, itemId: lines.find((l) => l.variant_id === i.variant_id)!.inventory_item_id! }))
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
  for (const it of toReserve) {
    const ok = await moveStock(trx, tenantId, it.itemId, {
      kind: 'reservation', quantity: it.quantity, dOnHand: 0, dReserved: it.quantity, reason: `order ${number}`,
      refType: 'order', refId: order.id, actorUserId: user.userId, requireActive: true,
    });
    if (!ok) throw Errors.conflict('out_of_stock', 'Some products are out of stock', { variant_ids: [it.variant_id] });
    await trx.insertInto('stock_reservations').values({
      tenant_id: tenantId, inventory_item_id: it.itemId, order_id: order.id, order_item_id: it.id, quantity: it.quantity, expires_at: expiresAt,
    }).execute();
  }
  if (coupon) await redeemCoupon(trx, tenantId, coupon.couponId, { tenantCustomerId, orderId: order.id, discountMinor: discount });
  await trx.updateTable('carts').set({ status: 'converted' }).where('id', '=', cartId!).execute();
  await event(trx, tenantId, order.id, { kind: 'created', to: 'pending_payment', actorUserId: user.userId, data: { lines: lines.length, total_minor: total } });
  await audit(trx, actor, 'order.created', { tenantId, targetType: 'order', targetId: order.id, data: { number, total_minor: total, coupon: !!coupon } });

  let status = 'pending_payment';
  if (total === 0) {
    // Fully discounted: nothing to pay, so the reservation becomes a sale now.
    await settlePaid(trx, tenantId, order.id, { paymentId: null, amountMinor: 0 });
    status = 'paid';
  }
  return {
    id: order.id, number, status, subtotal_minor: subtotal, discount_minor: discount, total_minor: total, currency: t.currency,
    expires_at: status === 'paid' ? null : expiresAt.toISOString(), checkout_path: `/s/${t.slug}/checkout/order/${order.id}`,
  };
}

// ── Payment ─────────────────────────────────────────────────────────────────
async function lockOrder(trx: Tx, tenantId: string, orderId: string) {
  const o = await trx.selectFrom('orders').selectAll().where('tenant_id', '=', tenantId).where('id', '=', orderId).forUpdate().executeTakeFirst();
  if (!o) throw Errors.notFound('order');
  return o;
}

async function settlePaid(trx: Tx, tenantId: string, orderId: string, payment: { paymentId: string | null; amountMinor: number }) {
  const o = await lockOrder(trx, tenantId, orderId);
  const reservations = await trx.selectFrom('stock_reservations').select(['id', 'inventory_item_id', 'quantity'])
    .where('order_id', '=', orderId).where('status', '=', 'active').orderBy('inventory_item_id').forUpdate().execute();
  for (const r of reservations) {
    const upd = await trx.updateTable('stock_reservations').set({ status: 'consumed' }).where('id', '=', r.id).where('status', '=', 'active').returning('id').executeTakeFirst();
    if (!upd) continue;
    const q = Number(r.quantity);
    const ok = await moveStock(trx, tenantId, r.inventory_item_id, { kind: 'sale', quantity: -q, dOnHand: -q, dReserved: -q, reason: `order ${o.number}`, refType: 'order', refId: orderId });
    if (!ok) throw new Error(`stock invariant violated converting reservation ${r.id}`);
  }
  await trx.updateTable('orders').set({ status: 'paid', paid_minor: o.paid_minor + payment.amountMinor, version: o.version + 1 }).where('id', '=', orderId).execute();
  await trx.insertInto('fulfillments').values({ tenant_id: tenantId, order_id: orderId, method: o.fulfillment_method, status: 'pending' })
    .onConflict((oc) => oc.columns(['tenant_id', 'order_id']).doNothing()).execute();
  await event(trx, tenantId, orderId, { kind: 'paid', from: o.status, to: 'paid', data: { payment_id: payment.paymentId, amount_minor: payment.amountMinor } });
  const slug = await tenantSlug(trx, tenantId);
  await notifyCapability(trx, tenantId, ['orders.manage'], {
    kind: 'order.paid', title_ar: `طلب جديد مدفوع ${o.number}`, title_en: `New paid order ${o.number}`,
    body_ar: 'جهّزي الطلب للاستلام.', body_en: 'Prepare the order for pickup.',
    target_path: slug ? `/app/${slug}/orders?order=${orderId}` : undefined, data: { order_id: orderId }, dedupe_key: `order_paid:${orderId}`,
  });
}

/**
 * Called by the payments webhook handler inside its own transaction.
 * Idempotent: only a pending_payment order changes; any later call is a no-op.
 * Partial amounts are recorded (paid_minor) without changing status until the
 * total is covered. A payment for an already cancelled/expired order returns
 * { changed: false, reason: 'order_cancelled' } so payments can flag it for
 * reconciliation/refund — stock is NOT re-reserved silently.
 */
export async function markOrderPaid(trx: Tx, tenantId: string, orderId: string, payment: { paymentId: string; amountMinor: number }): Promise<{ changed: boolean; reason?: 'order_cancelled' | 'already_paid' | 'partial' }> {
  const o = await lockOrder(trx, tenantId, orderId);
  if (o.status === 'cancelled') return { changed: false, reason: 'order_cancelled' };
  if (o.status !== 'pending_payment' && o.status !== 'draft') return { changed: false, reason: 'already_paid' };
  if (o.paid_minor + payment.amountMinor < o.total_minor) {
    await trx.updateTable('orders').set({ paid_minor: o.paid_minor + payment.amountMinor }).where('id', '=', orderId).execute();
    await event(trx, tenantId, orderId, { kind: 'payment_recorded', data: { payment_id: payment.paymentId, amount_minor: payment.amountMinor } });
    return { changed: true, reason: 'partial' };
  }
  await settlePaid(trx, tenantId, orderId, payment);
  return { changed: true };
}

// ── Cancellation & expiry ───────────────────────────────────────────────────
async function cancelTx(trx: Tx, tenantId: string, orderId: string, reason: string, actorUserId: string | null, opts: { onlyIfExpired?: boolean } = {}) {
  const o = await lockOrder(trx, tenantId, orderId);
  if (opts.onlyIfExpired && !(o.status === 'pending_payment' && o.expires_at && o.expires_at < new Date())) return { released: false, skipped: true };
  if (o.status === 'collected') throw Errors.conflict('order_collected', 'A collected order cannot be cancelled; record a return instead');
  if (o.status === 'cancelled') return { released: false, skipped: true };
  let released = false;
  const active = await trx.selectFrom('stock_reservations').select(['id', 'inventory_item_id', 'quantity'])
    .where('order_id', '=', orderId).where('status', '=', 'active').orderBy('inventory_item_id').forUpdate().execute();
  for (const r of active) {
    const upd = await trx.updateTable('stock_reservations').set({ status: 'released' }).where('id', '=', r.id).where('status', '=', 'active').returning('id').executeTakeFirst();
    if (!upd) continue;
    const q = Number(r.quantity);
    const ok = await moveStock(trx, tenantId, r.inventory_item_id, { kind: 'release', quantity: q, dOnHand: 0, dReserved: -q, reason, refType: 'order', refId: orderId, actorUserId });
    if (!ok) throw new Error(`stock invariant violated releasing reservation ${r.id}`);
    released = true;
  }
  if (['paid', 'preparing', 'ready'].includes(o.status)) {
    // Sold but never handed over: the goods are still on the shelf.
    const sold = await trx.selectFrom('stock_reservations').select(['inventory_item_id', 'quantity'])
      .where('order_id', '=', orderId).where('status', '=', 'consumed').orderBy('inventory_item_id').execute();
    for (const r of sold) {
      const q = Number(r.quantity);
      await moveStock(trx, tenantId, r.inventory_item_id, { kind: 'return', quantity: q, dOnHand: q, dReserved: 0, reason: `cancelled: ${reason}`, refType: 'order_cancel', refId: orderId, actorUserId });
      released = true;
    }
  }
  const expired = reason === 'payment_expired';
  await trx.updateTable('orders').set({
    status: 'cancelled', cancelled_at: new Date(), cancelled_by: actorUserId, cancel_reason: reason, version: o.version + 1,
    ...(released ? { stock_released_at: new Date() } : {}),
  }).where('id', '=', orderId).execute();
  await trx.updateTable('fulfillments').set({ status: 'cancelled' }).where('order_id', '=', orderId).execute();
  await releaseCouponRedemption(trx, tenantId, { orderId });
  await event(trx, tenantId, orderId, { kind: expired ? 'expired' : 'cancelled', from: o.status, to: 'cancelled', reason, actorUserId });
  if (o.customer_user_id && actorUserId !== o.customer_user_id) {
    await notifyUsers(trx, tenantId, [o.customer_user_id], {
      kind: 'order.cancelled', title_ar: `تم إلغاء الطلب ${o.number}`, title_en: `Order ${o.number} was cancelled`,
      body_ar: expired ? 'انتهت مهلة الدفع.' : undefined, body_en: expired ? 'The payment window expired.' : undefined,
      data: { order_id: orderId }, dedupe_key: `order_cancelled:${orderId}`,
    });
  }
  return { released, skipped: false };
}

/**
 * Cancels an order and releases its stock exactly once. Refuses collected
 * orders (409 order_collected). Already-cancelled orders return { released: false }.
 * Refunds are handled by payments, not here. Use reason 'payment_failed' for a
 * definitive payment failure; expiry uses 'payment_expired'.
 */
export async function cancelOrder(trx: Tx, tenantId: string, orderId: string, reason: string, actorUserId: string | null): Promise<{ released: boolean }> {
  const r = await cancelTx(trx, tenantId, orderId, reason, actorUserId);
  return { released: r.released };
}

/** Periodic sweeper: pending_payment orders past expires_at → cancelled, stock released exactly once. */
export async function expireStaleOrders(limit = 200): Promise<{ expired: number }> {
  const due = await withSystem('order expiry sweep: find candidates', (trx) => trx.selectFrom('orders').select(['id', 'tenant_id'])
    .where('status', '=', 'pending_payment').where('expires_at', '<', new Date()).orderBy('expires_at').limit(limit).execute());
  let expired = 0;
  for (const o of due) {
    try {
      const r = await withTenant(o.tenant_id, (trx) => cancelTx(trx, o.tenant_id, o.id, 'payment_expired', null, { onlyIfExpired: true }));
      if (!r.skipped) expired++;
    } catch (e) {
      console.error('[commerce] order expiry failed', o.id, (e as Error).message);
    }
  }
  return { expired };
}

export async function abandonStaleCarts() {
  await withSystem('cart expiry sweep', (trx) => trx.updateTable('carts').set({ status: 'abandoned' }).where('status', '=', 'open').where('expires_at', '<', new Date()).execute());
}

// ── Dashboard ───────────────────────────────────────────────────────────────
const OPEN = ['pending_payment', 'paid', 'preparing', 'ready'] as const;

export async function listOrders(access: TenantAccess, query: z.infer<typeof orderListQuery>) {
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('orders as o').innerJoin('tenant_customers as c', 'c.id', 'o.tenant_customer_id').where('o.tenant_id', '=', access.tenantId);
    if (query.status === 'open') q = q.where('o.status', 'in', [...OPEN]);
    else if (query.status && query.status !== 'all') q = q.where('o.status', '=', query.status);
    if (query.q) {
      const like = `%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      q = q.where((eb) => eb.or([eb('o.number', 'ilike', like), eb('c.display_name', 'ilike', like), eb('c.phone', 'ilike', like)]));
    }
    const dir = query.dir ?? 'desc';
    const order = query.sort === 'total' ? 'o.total_minor' : query.sort === 'number' ? 'o.number' : 'o.created_at';
    const rows = await q.select([
      'o.id', 'o.number', 'o.status', 'o.refund_status', 'o.fulfillment_method', 'o.booking_id', 'o.subtotal_minor', 'o.discount_minor', 'o.total_minor',
      'o.paid_minor', 'o.currency', 'o.created_at', 'o.expires_at', 'c.display_name as customer_name', 'c.phone as customer_phone',
      sql<number>`(select coalesce(sum(i.quantity), 0)::int from order_items i where i.order_id = o.id)`.as('item_count'),
      sql<number>`count(*) over ()`.as('total'),
    ]).orderBy(order, dir).orderBy('o.id').limit(query.limit).offset(query.offset).execute();
    const counts = await trx.selectFrom('orders').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute();
    return { items: rows.map(({ total: _t, ...r }) => r), total: Number(rows[0]?.total ?? 0), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  });
}

export async function getOrder(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const o = await trx.selectFrom('orders as o').innerJoin('tenant_customers as c', 'c.id', 'o.tenant_customer_id')
      .leftJoin('bookings as b', 'b.id', 'o.booking_id')
      .selectAll('o').select(['c.display_name as customer_name', 'c.phone as customer_phone', 'c.email as customer_email', 'b.number as booking_number', 'b.starts_at as booking_starts_at'])
      .where('o.id', '=', id).executeTakeFirst();
    if (!o) throw Errors.notFound('order');
    const showCost = hasCapability(access, 'costs.view');
    const items = await trx.selectFrom('order_items').selectAll().where('order_id', '=', id).orderBy('created_at').execute();
    const [fulfillment, events, payments, returns, coupon] = await Promise.all([
      trx.selectFrom('fulfillments').selectAll().where('order_id', '=', id).executeTakeFirst(),
      trx.selectFrom('order_events as e').leftJoin('users as u', 'u.id', 'e.actor_user_id')
        .select(['e.id', 'e.kind', 'e.from_status', 'e.to_status', 'e.reason', 'e.created_at', 'u.display_name as actor_name'])
        .where('e.order_id', '=', id).orderBy('e.created_at').execute(),
      trx.selectFrom('payments').select(['id', 'kind', 'method', 'amount_minor', 'currency', 'status', 'provider', 'captured_at', 'created_at']).where('order_id', '=', id).orderBy('created_at').execute(),
      trx.selectFrom('returns').selectAll().where('order_id', '=', id).orderBy('created_at').execute(),
      o.coupon_id ? trx.selectFrom('coupons').select(['code', 'kind', 'value']).where('id', '=', o.coupon_id).executeTakeFirst() : Promise.resolve(undefined),
    ]);
    const { payment_terms: _pt, attribution: _a, ...order } = o;
    return {
      ...order, coupon: coupon ?? null, fulfillment: fulfillment ?? null, events, payments, returns,
      items: items.map(({ unit_cost_minor, ...i }) => ({ ...i, ...(showCost ? { unit_cost_minor } : {}) })),
      allowed_transitions: allowedTransitions(o.status),
      can_cancel: o.status !== 'collected' && o.status !== 'cancelled',
    };
  });
}

/** Pickup and with-visit fulfillment; 'delivery' exists in the data model but is not offered. */
const TRANSITIONS: Record<string, string[]> = { paid: ['preparing', 'ready', 'collected'], preparing: ['ready', 'collected'], ready: ['collected'] };
export function allowedTransitions(status: string) {
  return TRANSITIONS[status] ?? [];
}

export async function setFulfillmentStatus(access: TenantAccess, actor: AuditActor, id: string, to: 'preparing' | 'ready' | 'collected') {
  await withTenant(access.tenantId, async (trx) => {
    const o = await lockOrder(trx, access.tenantId, id);
    if (!allowedTransitions(o.status).includes(to)) throw Errors.conflict('invalid_transition', `Cannot move an order from ${o.status} to ${to}`, { from: o.status, to });
    await trx.updateTable('orders').set({ status: to, version: o.version + 1 }).where('id', '=', id).execute();
    await trx.insertInto('fulfillments').values({ tenant_id: access.tenantId, order_id: id, method: o.fulfillment_method, status: to })
      .onConflict((oc) => oc.columns(['tenant_id', 'order_id']).doUpdateSet({ status: to })).execute();
    if (to === 'ready') await trx.updateTable('fulfillments').set({ ready_at: new Date() }).where('order_id', '=', id).execute();
    if (to === 'collected') await trx.updateTable('fulfillments').set({ collected_at: new Date(), collected_by: actor.userId }).where('order_id', '=', id).execute();
    await event(trx, access.tenantId, id, { kind: 'status_changed', from: o.status, to, actorUserId: actor.userId });
    await audit(trx, actor, 'order.status_changed', { tenantId: access.tenantId, targetType: 'order', targetId: id, data: { from: o.status, to } });
    if (to === 'ready' && o.customer_user_id) {
      await notifyUsers(trx, access.tenantId, [o.customer_user_id], {
        kind: 'order.ready', title_ar: `طلبك ${o.number} جاهز للاستلام`, title_en: `Your order ${o.number} is ready for pickup`,
        data: { order_id: id }, dedupe_key: `order_ready:${id}`,
      });
    }
  });
  return getOrder(access, id);
}

export async function cancelOrderByStaff(access: TenantAccess, actor: AuditActor, id: string, reason: string) {
  const r = await withTenant(access.tenantId, async (trx) => {
    const res = await cancelOrder(trx, access.tenantId, id, reason, actor.userId);
    await audit(trx, actor, 'order.cancelled', { tenantId: access.tenantId, targetType: 'order', targetId: id, data: { reason, released: res.released } });
    return res;
  });
  return { ...(await getOrder(access, id)), released: r.released };
}

// ── Returns ─────────────────────────────────────────────────────────────────
type ReturnItem = { order_item_id: string; quantity: number };

/** Returns follow the product type (returnable snapshot) and need an approval decision. */
export async function createReturn(access: TenantAccess, actor: AuditActor, orderId: string, input: z.infer<typeof returnInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const o = await lockOrder(trx, access.tenantId, orderId);
    if (o.status !== 'collected') throw Errors.conflict('order_not_collected', 'Only collected orders can be returned; cancel undelivered orders instead');
    const items = await trx.selectFrom('order_items').select(['id', 'quantity', 'returnable']).where('order_id', '=', orderId).execute();
    const prior = await trx.selectFrom('returns').select('items').where('order_id', '=', orderId).where('status', '<>', 'rejected').execute();
    const returned = new Map<string, number>();
    for (const p of prior) for (const i of p.items as ReturnItem[]) returned.set(i.order_item_id, (returned.get(i.order_item_id) ?? 0) + i.quantity);
    const seen = new Set<string>();
    for (const ri of input.items) {
      if (seen.has(ri.order_item_id)) throw Errors.invalid('duplicate_line', 'Each item can appear once');
      seen.add(ri.order_item_id);
      const it = items.find((i) => i.id === ri.order_item_id);
      if (!it) throw Errors.notFound('order_item');
      if (!it.returnable) throw Errors.invalid('not_returnable', 'This product cannot be returned');
      if ((returned.get(it.id) ?? 0) + ri.quantity > it.quantity) throw Errors.invalid('return_quantity_exceeded', 'More than was bought');
    }
    const r = await trx.insertInto('returns').values({
      tenant_id: access.tenantId, order_id: orderId, reason: input.reason, items: JSON.stringify(input.items), restock: input.restock,
    }).returningAll().executeTakeFirstOrThrow();
    await event(trx, access.tenantId, orderId, { kind: 'return_requested', reason: input.reason, actorUserId: actor.userId, data: { return_id: r.id } });
    await audit(trx, actor, 'order.return_requested', { tenantId: access.tenantId, targetType: 'order', targetId: orderId, data: { return_id: r.id, items: input.items } });
    return r;
  });
}

export async function decideReturn(access: TenantAccess, actor: AuditActor, orderId: string, returnId: string, decision: 'approved' | 'rejected') {
  return withTenant(access.tenantId, async (trx) => {
    const o = await lockOrder(trx, access.tenantId, orderId);
    const r = await trx.selectFrom('returns').selectAll().where('id', '=', returnId).where('order_id', '=', orderId).forUpdate().executeTakeFirst();
    if (!r) throw Errors.notFound('return');
    if (r.status !== 'requested') throw Errors.conflict('already_decided');
    if (decision === 'approved' && r.restock) {
      const items = r.items as ReturnItem[];
      const ois = await trx.selectFrom('order_items as oi').innerJoin('inventory_items as ii', (j) => j.onRef('ii.variant_id', '=', 'oi.variant_id').on('ii.branch_id', '=', o.branch_id))
        .select(['oi.id', 'ii.id as item_id']).where('oi.order_id', '=', orderId).execute();
      for (const ri of items) {
        const m = ois.find((x) => x.id === ri.order_item_id);
        if (!m) continue;
        await moveStock(trx, access.tenantId, m.item_id, { kind: 'return', quantity: ri.quantity, dOnHand: ri.quantity, dReserved: 0, reason: r.reason, refType: 'return', refId: returnId, actorUserId: actor.userId });
      }
    }
    const row = await trx.updateTable('returns').set({ status: decision, decided_by: actor.userId }).where('id', '=', returnId).returningAll().executeTakeFirstOrThrow();
    await event(trx, access.tenantId, orderId, { kind: decision === 'approved' ? 'return_approved' : 'return_rejected', actorUserId: actor.userId, data: { return_id: returnId, restocked: decision === 'approved' && r.restock } });
    await audit(trx, actor, `order.return_${decision}`, { tenantId: access.tenantId, targetType: 'order', targetId: orderId, data: { return_id: returnId } });
    return row;
  });
}

// ── Customer view (storefront checkout page) ────────────────────────────────
/** The signed-in customer's own order (no costs, no internal notes). */
export async function getCustomerOrder(tenantId: string, userId: string, orderId: string) {
  return withTenant(tenantId, async (trx) => {
    const o = await trx.selectFrom('orders').select(['id', 'number', 'status', 'refund_status', 'fulfillment_method', 'booking_id', 'subtotal_minor', 'discount_minor', 'tax_minor',
      'total_minor', 'paid_minor', 'currency', 'expires_at', 'created_at', 'customer_note'])
      .where('id', '=', orderId).where('customer_user_id', '=', userId).executeTakeFirst();
    if (!o) throw Errors.notFound('order');
    const items = await trx.selectFrom('order_items').select(['id', 'variant_id', 'name_ar', 'name_en', 'variant_name_ar', 'variant_name_en', 'unit_price_minor', 'quantity', 'line_total_minor'])
      .where('order_id', '=', orderId).orderBy('created_at').execute();
    return { ...o, items };
  });
}

export function isOutOfStock(e: unknown) {
  return e instanceof AppError && e.code === 'out_of_stock';
}
