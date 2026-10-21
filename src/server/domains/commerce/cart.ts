import { sql } from 'kysely';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { hashToken, newToken } from '../../auth/crypto';
import { primaryBranchId } from './stock';
import { validateCoupon } from './coupons';

/**
 * Storefront cart. Scope = one business (carts.tenant_id), so items of two
 * businesses can never mix. Prices, stock and limits are re-read from the
 * catalog on every view; `added_unit_price_minor` remembers what the customer
 * saw so price changes are flagged before checkout. Browser-supplied prices
 * are never read.
 *
 * Anonymous carts: an httpOnly cookie holds a random token; only its keyed hash
 * is stored. One token serves every business (one cart row per business). On
 * sign-in the anonymous cart is merged into the user's cart.
 */
export const CART_COOKIE = 'luma_cart';
export type CartIdentity = { userId: string | null; anonToken: string | null };

const anonHash = (token: string) => hashToken(token, 'cart');

export type CartLineProblem = 'unavailable' | 'out_of_stock' | 'insufficient_stock' | 'exceeds_max_per_order';
export type CartLine = {
  variant_id: string; product_id: string; inventory_item_id: string | null;
  name_ar: string | null; name_en: string | null; variant_name_ar: string | null; variant_name_en: string | null; sku: string | null;
  image_asset_id: string | null; quantity: number; unit_price_minor: number; added_unit_price_minor: number; price_changed: boolean;
  line_total_minor: number; available: number; max_per_order: number; returnable: boolean; unit_cost_minor: number | null; problems: CartLineProblem[];
};
export type CartView = {
  id: string | null; items: CartLine[]; item_count: number; subtotal_minor: number; currency: string;
  has_price_changes: boolean; has_problems: boolean; fulfillment_methods: Array<{ method: string; enabled: boolean }>;
};

const FULFILLMENT = [{ method: 'pickup', enabled: true }, { method: 'with_visit', enabled: true }, { method: 'delivery', enabled: false }];

async function loadLines(trx: Tx, tenantId: string, cartId: string): Promise<CartLine[]> {
  const branchId = await primaryBranchId(trx, tenantId);
  const rows = await trx.selectFrom('cart_items as ci')
    .innerJoin('product_variants as v', 'v.id', 'ci.variant_id')
    .innerJoin('products as p', 'p.id', 'v.product_id')
    .leftJoin('inventory_items as ii', (j) => j.onRef('ii.variant_id', '=', 'v.id').on('ii.branch_id', '=', branchId))
    .select(['ci.variant_id', 'ci.quantity', 'ci.added_unit_price_minor', 'v.product_id', 'v.price_minor', 'v.cost_minor', 'v.is_active as variant_active',
      'v.name_ar as variant_name_ar', 'v.name_en as variant_name_en', 'v.sku',
      'p.name_ar', 'p.name_en', 'p.status', 'p.is_visible', 'p.max_per_order', 'p.returnable',
      'ii.id as inventory_item_id', 'ii.on_hand', 'ii.reserved', 'ii.is_active as item_active',
      sql<string | null>`(select pi.asset_id from product_images pi where pi.product_id = p.id order by pi.sort limit 1)`.as('image_asset_id')])
    .where('ci.tenant_id', '=', tenantId).where('ci.cart_id', '=', cartId).orderBy('ci.created_at').execute();
  const perProduct = new Map<string, number>();
  for (const r of rows) perProduct.set(r.product_id, (perProduct.get(r.product_id) ?? 0) + r.quantity);
  return rows.map((r) => {
    const available = r.inventory_item_id && r.item_active ? Math.max(0, Number(r.on_hand) - Number(r.reserved)) : 0;
    const problems: CartLineProblem[] = [];
    if (r.status !== 'active' || !r.is_visible || !r.variant_active) problems.push('unavailable');
    else if (available < 1) problems.push('out_of_stock');
    else if (available < r.quantity) problems.push('insufficient_stock');
    if ((perProduct.get(r.product_id) ?? 0) > r.max_per_order) problems.push('exceeds_max_per_order');
    return {
      variant_id: r.variant_id, product_id: r.product_id, inventory_item_id: r.inventory_item_id,
      name_ar: r.name_ar, name_en: r.name_en, variant_name_ar: r.variant_name_ar, variant_name_en: r.variant_name_en, sku: r.sku,
      image_asset_id: r.image_asset_id, quantity: r.quantity, unit_price_minor: r.price_minor, added_unit_price_minor: r.added_unit_price_minor,
      price_changed: r.price_minor !== r.added_unit_price_minor, line_total_minor: r.price_minor * r.quantity, available,
      max_per_order: r.max_per_order, returnable: r.returnable, unit_cost_minor: r.cost_minor, problems,
    };
  });
}

/** Public cart view: never includes costs. */
export async function buildCartView(trx: Tx, tenantId: string, cartId: string | null): Promise<CartView> {
  const t = await trx.selectFrom('tenants').select('currency').where('id', '=', tenantId).executeTakeFirst();
  const lines = cartId ? await loadLines(trx, tenantId, cartId) : [];
  const items = lines.map((l) => ({ ...l, unit_cost_minor: null, inventory_item_id: null }));
  return {
    id: cartId, items, item_count: items.reduce((a, l) => a + l.quantity, 0),
    subtotal_minor: items.filter((l) => !l.problems.includes('unavailable')).reduce((a, l) => a + l.line_total_minor, 0),
    currency: t?.currency ?? 'SAR', has_price_changes: items.some((l) => l.price_changed), has_problems: items.some((l) => l.problems.length > 0),
    fulfillment_methods: FULFILLMENT,
  };
}

/** Lines with server-side data for order creation (includes costs for snapshots; never returned to the browser). */
export const cartLinesForOrder = loadLines;

async function findCart(trx: Tx, tenantId: string, ident: CartIdentity, lock = false) {
  let q = trx.selectFrom('carts').select(['id']).where('tenant_id', '=', tenantId).where('status', '=', 'open');
  if (ident.userId) q = q.where('customer_user_id', '=', ident.userId);
  else if (ident.anonToken) q = q.where('anon_token_hash', '=', anonHash(ident.anonToken)).where('customer_user_id', 'is', null);
  else return null;
  if (lock) q = q.forUpdate();
  return (await q.executeTakeFirst())?.id ?? null;
}

async function createCart(trx: Tx, tenantId: string, ident: CartIdentity): Promise<string> {
  const values = ident.userId
    ? { tenant_id: tenantId, customer_user_id: ident.userId }
    : { tenant_id: tenantId, anon_token_hash: anonHash(ident.anonToken!) };
  const row = await trx.insertInto('carts').values(values)
    .onConflict((oc) => ident.userId
      ? oc.columns(['tenant_id', 'customer_user_id']).where('status', '=', 'open').where('customer_user_id', 'is not', null).doNothing()
      : oc.columns(['tenant_id', 'anon_token_hash']).where('status', '=', 'open').where('anon_token_hash', 'is not', null).doNothing())
    .returning('id').executeTakeFirst();
  if (row) return row.id;
  return (await findCart(trx, tenantId, ident))!;
}

/** Merges an anonymous cart into the signed-in customer's cart (summing quantities, capped). */
async function mergeAnon(trx: Tx, tenantId: string, userId: string, anonToken: string) {
  const anon = await findCart(trx, tenantId, { userId: null, anonToken }, true);
  if (!anon) return;
  const userCart = await createCart(trx, tenantId, { userId, anonToken: null });
  await sql`
    insert into cart_items (tenant_id, cart_id, variant_id, quantity, added_unit_price_minor)
    select tenant_id, ${userCart}, variant_id, quantity, added_unit_price_minor from cart_items where cart_id = ${anon}
    on conflict (cart_id, variant_id) do update set quantity = least(999, cart_items.quantity + excluded.quantity)`.execute(trx);
  await trx.updateTable('carts').set({ status: 'abandoned' }).where('id', '=', anon).execute();
}

async function resolveCart(trx: Tx, tenantId: string, ident: CartIdentity, create: boolean) {
  if (ident.userId && ident.anonToken) await mergeAnon(trx, tenantId, ident.userId, ident.anonToken);
  const id = await findCart(trx, tenantId, ident, true);
  if (id || !create) return id;
  return createCart(trx, tenantId, ident);
}

async function touch(trx: Tx, cartId: string) {
  await trx.updateTable('carts').set({ expires_at: sql`now() + interval '7 days'` }).where('id', '=', cartId).execute();
}

export async function getCart(tenantId: string, ident: CartIdentity): Promise<CartView> {
  return withTenant(tenantId, async (trx) => buildCartView(trx, tenantId, await resolveCart(trx, tenantId, ident, false)));
}

/** Ensures an anonymous visitor has a token before a cart is created. */
export function ensureAnonToken(ident: CartIdentity): { ident: CartIdentity; issued: string | null } {
  if (ident.userId || ident.anonToken) return { ident, issued: null };
  const token = newToken();
  return { ident: { userId: null, anonToken: token }, issued: token };
}

async function purchasableVariant(trx: Tx, tenantId: string, variantId: string) {
  const branchId = await primaryBranchId(trx, tenantId);
  const v = await trx.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id')
    .leftJoin('inventory_items as ii', (j) => j.onRef('ii.variant_id', '=', 'v.id').on('ii.branch_id', '=', branchId))
    .select(['v.id', 'v.product_id', 'v.price_minor', 'v.is_active', 'p.status', 'p.is_visible', 'p.max_per_order', 'ii.on_hand', 'ii.reserved', 'ii.is_active as item_active'])
    .where('v.tenant_id', '=', tenantId).where('v.id', '=', variantId).executeTakeFirst();
  // Another business's variant is invisible under RLS → indistinguishable from a missing one.
  if (!v) throw Errors.notFound('product');
  if (!v.is_active || v.status !== 'active' || !v.is_visible) throw Errors.invalid('product_unavailable', 'This product is not available');
  const available = v.item_active ? Math.max(0, Number(v.on_hand ?? 0) - Number(v.reserved ?? 0)) : 0;
  return { ...v, available };
}

async function checkLimits(trx: Tx, tenantId: string, cartId: string, v: Awaited<ReturnType<typeof purchasableVariant>>, newQty: number) {
  if (v.available < 1) throw Errors.conflict('out_of_stock', 'This product is out of stock', { variant_id: v.id, available: 0 });
  if (newQty > v.available) throw Errors.conflict('out_of_stock', 'Not enough stock for this quantity', { variant_id: v.id, available: v.available });
  const others = await trx.selectFrom('cart_items as ci').innerJoin('product_variants as pv', 'pv.id', 'ci.variant_id')
    .select(sql<number>`coalesce(sum(ci.quantity), 0)::int`.as('n'))
    .where('ci.cart_id', '=', cartId).where('pv.product_id', '=', v.product_id).where('ci.variant_id', '<>', v.id).executeTakeFirstOrThrow();
  if (others.n + newQty > v.max_per_order) {
    throw Errors.invalid('max_per_order_exceeded', `At most ${v.max_per_order} per order`, { max_per_order: v.max_per_order });
  }
}

/** Adds a variant; a duplicate line is merged into the existing line (quantity summed). */
export async function addToCart(tenantId: string, ident: CartIdentity, input: { variant_id: string; quantity: number }): Promise<CartView> {
  return withTenant(tenantId, async (trx) => {
    const v = await purchasableVariant(trx, tenantId, input.variant_id);
    const cartId = (await resolveCart(trx, tenantId, ident, true))!;
    const cur = await trx.selectFrom('cart_items').select('quantity').where('cart_id', '=', cartId).where('variant_id', '=', v.id).executeTakeFirst();
    const newQty = (cur?.quantity ?? 0) + input.quantity;
    if (newQty > 999) throw Errors.invalid('quantity_too_large', 'Quantity is too large');
    await checkLimits(trx, tenantId, cartId, v, newQty);
    if (cur) await trx.updateTable('cart_items').set({ quantity: newQty }).where('cart_id', '=', cartId).where('variant_id', '=', v.id).execute();
    else await trx.insertInto('cart_items').values({ tenant_id: tenantId, cart_id: cartId, variant_id: v.id, quantity: newQty, added_unit_price_minor: v.price_minor }).execute();
    await touch(trx, cartId);
    return buildCartView(trx, tenantId, cartId);
  });
}

export async function setCartQuantity(tenantId: string, ident: CartIdentity, variantId: string, quantity: number): Promise<CartView> {
  return withTenant(tenantId, async (trx) => {
    const cartId = await resolveCart(trx, tenantId, ident, false);
    if (!cartId) throw Errors.notFound('cart_item');
    const cur = await trx.selectFrom('cart_items').select('quantity').where('cart_id', '=', cartId).where('variant_id', '=', variantId).executeTakeFirst();
    if (!cur) throw Errors.notFound('cart_item');
    if (quantity > cur.quantity) {
      const v = await purchasableVariant(trx, tenantId, variantId);
      await checkLimits(trx, tenantId, cartId, v, quantity);
    }
    await trx.updateTable('cart_items').set({ quantity }).where('cart_id', '=', cartId).where('variant_id', '=', variantId).execute();
    await touch(trx, cartId);
    return buildCartView(trx, tenantId, cartId);
  });
}

export async function removeFromCart(tenantId: string, ident: CartIdentity, variantId: string): Promise<CartView> {
  return withTenant(tenantId, async (trx) => {
    const cartId = await resolveCart(trx, tenantId, ident, false);
    if (cartId) await trx.deleteFrom('cart_items').where('cart_id', '=', cartId).where('variant_id', '=', variantId).execute();
    return buildCartView(trx, tenantId, cartId);
  });
}

/** The customer has seen the current prices: remember them so checkout can proceed. */
export async function acknowledgeCartPrices(tenantId: string, ident: CartIdentity): Promise<CartView> {
  return withTenant(tenantId, async (trx) => {
    const cartId = await resolveCart(trx, tenantId, ident, false);
    if (cartId) {
      await sql`update cart_items ci set added_unit_price_minor = v.price_minor
        from product_variants v where v.id = ci.variant_id and ci.cart_id = ${cartId} and ci.added_unit_price_minor <> v.price_minor`.execute(trx);
    }
    return buildCartView(trx, tenantId, cartId);
  });
}

/** Coupon preview against the current cart (no redemption; checkout re-validates). */
export async function previewCoupon(tenantId: string, user: { userId: string }, ident: CartIdentity, code: string) {
  return withTenant(tenantId, async (trx) => {
    const cartId = await resolveCart(trx, tenantId, ident, false);
    const view = await buildCartView(trx, tenantId, cartId);
    const tc = await trx.selectFrom('tenant_customers').select('id').where('user_id', '=', user.userId).executeTakeFirst();
    // No relationship yet ⇒ no prior redemptions; the nil id matches none.
    const r = await validateCoupon(trx, tenantId, code, { tenantCustomerId: tc?.id ?? '00000000-0000-0000-0000-000000000000', subtotalMinor: view.subtotal_minor, appliesTo: 'products' });
    return { code: code.trim().toUpperCase(), discount_minor: r.discountMinor, subtotal_minor: view.subtotal_minor, total_minor: view.subtotal_minor - r.discountMinor };
  });
}

/** Locks and returns the signed-in customer's open cart (merging any anonymous cart first). */
export async function lockCustomerCart(trx: Tx, tenantId: string, ident: CartIdentity) {
  return resolveCart(trx, tenantId, ident, false);
}
