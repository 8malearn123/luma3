import { withSystem, withTenant } from '@/server/db/client';
import { createBusinessFor, signup } from './factory';
import type { TestClient } from './http';
import * as products from '@/app/api/v1/t/[tenantSlug]/products/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import * as cartItems from '@/app/api/v1/s/[slug]/cart/items/route';
import * as orders from '@/app/api/v1/s/[slug]/orders/route';

/** A business whose storefront is live (status active) on the given plan. */
export async function liveShop(plan: 'sanaa' | 'wahaj' | 'fareed' = 'wahaj') {
  const owner = await signup('Owner');
  const biz = await createBusinessFor(owner, { plan_code: plan });
  await withSystem('test: activate storefront', (trx) => trx.updateTable('tenants').set({ status: 'active' }).where('id', '=', biz.tenantId).execute());
  return { owner, biz, p: { tenantSlug: biz.slug }, s: { slug: biz.slug } };
}

export async function createProduct(owner: TestClient, slug: string, overrides: Record<string, unknown> = {}, variant: Record<string, unknown> = {}) {
  const r = await owner.call(products.POST, {
    params: { tenantSlug: slug },
    body: { name_ar: 'شامبو', name_en: 'Shampoo', variants: [{ price_minor: 10000, initial_stock: 5, ...variant }], ...overrides },
  });
  if (r.status !== 201) throw new Error(`create product failed: ${JSON.stringify(r.body)}`);
  return r.body.data as { id: string; version: number; variants: Array<{ id: string; inventory_item_id: string; available: number; price_minor: number }> };
}

export async function addMember(owner: TestClient, slug: string, role: 'receptionist' | 'specialist' | 'manager' | 'finance') {
  const m = await signup(role);
  const inv = await owner.call(invitations.POST, { params: { tenantSlug: slug }, body: { identifier: m.identifier, role } });
  if (inv.status !== 201) throw new Error(`invite failed: ${JSON.stringify(inv.body)}`);
  const token = inv.body.data.dev_invite_link.split('/invite/')[1];
  const acc = await m.call(accept.POST, { body: { token } });
  if (acc.status !== 200) throw new Error(`accept failed: ${JSON.stringify(acc.body)}`);
  return m;
}

export async function addToCart(c: TestClient, slug: string, variantId: string, quantity = 1) {
  return c.call(cartItems.POST, { params: { slug }, body: { variant_id: variantId, quantity } });
}

export async function checkout(c: TestClient, slug: string, body: Record<string, unknown> = {}, key: string | true = true) {
  return c.call(orders.POST, { params: { slug }, body, idempotencyKey: key });
}

export async function stock(tenantId: string, itemId: string) {
  return withTenant(tenantId, (trx) => trx.selectFrom('inventory_items').select(['on_hand', 'reserved']).where('id', '=', itemId).executeTakeFirstOrThrow());
}

export async function movements(tenantId: string, itemId: string) {
  return withTenant(tenantId, (trx) => trx.selectFrom('stock_movements').select(['kind', 'quantity', 'ref_type', 'ref_id']).where('inventory_item_id', '=', itemId).orderBy('created_at').execute());
}
