/**
 * Commerce domain public contract (products, inventory, carts, orders, coupons).
 * Other domains import ONLY from this file.
 *
 *  Orders
 *   createOrderFromCart({ tenantId, user, input, idempotencyKey, actor, anonToken? })
 *       → Promise<{ order: OrderSummary; replayed: boolean }>
 *   markOrderPaid(trx, tenantId, orderId, { paymentId, amountMinor })
 *       → Promise<{ changed: boolean; reason?: 'order_cancelled' | 'already_paid' | 'partial' }>
 *   cancelOrder(trx, tenantId, orderId, reason, actorUserId) → Promise<{ released: boolean }>
 *   expireStaleOrders() → Promise<{ expired: number }>   (also registered as a periodic task)
 *  Inventory
 *   consumeMaterialsForBookingItem(trx, tenantId, bookingItemId, actorUserId)
 *       → Promise<{ consumed: {inventoryItemId, quantity, unit}[]; skipped: 'no_recipe' | 'already_consumed' | null; shortages: [...] }>
 *   capacityEstimate(trx, tenantId, serviceId) → Promise<CapacityEstimate>
 *  Coupons
 *   validateCoupon(trx, tenantId, code, { tenantCustomerId, subtotalMinor, appliesTo }) → Promise<{ couponId, discountMinor }>
 *   redeemCoupon(trx, tenantId, couponId, { tenantCustomerId, bookingId?, orderId?, discountMinor }) → Promise<{ redemptionId }>
 *   releaseCouponRedemption(trx, tenantId, { bookingId?, orderId? }) → Promise<{ released: number }>
 *  Storefront
 *   publicVariantAvailability(trx, tenantId, variantIds) — price/stock/purchasable/hidden per variant, never costs.
 */
export { createOrderFromCart, markOrderPaid, cancelOrder, expireStaleOrders, getCustomerOrder, ORDER_PAYMENT_TTL_MIN, type OrderSummary } from './orders';
export { consumeMaterialsForBookingItem, capacityEstimate, type CapacityEstimate, type ConsumptionResult } from './inventory';
export { validateCoupon, redeemCoupon, releaseCouponRedemption, computeDiscount } from './coupons';
export { publicVariantAvailability } from './products';
export { resolveStorefront, type StorefrontTenant } from './storefront';
export { CART_COOKIE } from './cart';
