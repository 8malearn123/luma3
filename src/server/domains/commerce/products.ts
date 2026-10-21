import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { hasCapability, requireWithinLimit, type TenantAccess } from '../../tenancy/access';
import { assertTenantAssets } from '../assets/service';
import { moveStock, primaryBranchId } from './stock';
import type { ProductInput, ProductPatch, productListQuery } from '@/shared/schemas/commerce';

/**
 * Products & variants. Every product has exactly one default variant (DB
 * partial unique index). Each variant gets a retail inventory item at the
 * primary branch, so stock is always tracked; out-of-stock variants cannot be
 * purchased. Costs (variant cost_minor) are returned/accepted only with
 * `costs.view`. Products are archived, never deleted.
 */
type VariantIn = ProductInput['variants'][number];

function canSeeCosts(access: TenantAccess) {
  return hasCapability(access, 'costs.view');
}

function assertCostsAllowed(access: TenantAccess, variants: VariantIn[] | undefined) {
  if (variants?.some((v) => v.cost_minor !== undefined) && !canSeeCosts(access)) {
    throw Errors.forbidden('You cannot set confidential costs');
  }
}

function itemName(p: { name_ar: string | null; name_en: string | null }, v: { name_ar?: string | null; name_en?: string | null }) {
  const pn = p.name_ar || p.name_en || '';
  const vn = v.name_ar || v.name_en;
  return (vn ? `${pn} — ${vn}` : pn).slice(0, 160);
}

async function countActiveProducts(trx: Tx, tenantId: string) {
  const r = await trx.selectFrom('products').select(sql<number>`count(*)::int`.as('n')).where('tenant_id', '=', tenantId).where('status', '<>', 'archived').executeTakeFirstOrThrow();
  return r.n;
}

async function assertProductCategory(trx: Tx, id: string | null | undefined) {
  if (!id) return;
  const c = await trx.selectFrom('categories').select('kind').where('id', '=', id).where('archived_at', 'is', null).executeTakeFirst();
  if (!c || c.kind !== 'product') throw Errors.invalid('invalid_reference', 'Choose a product category');
}

async function setImages(trx: Tx, tenantId: string, productId: string, ids: string[]) {
  await assertTenantAssets(trx, tenantId, ids);
  await trx.deleteFrom('product_images').where('product_id', '=', productId).execute();
  const unique = [...new Set(ids)];
  if (unique.length) {
    await trx.insertInto('product_images').values(unique.map((asset_id, sort) => ({ tenant_id: tenantId, product_id: productId, asset_id, sort }))).execute();
  }
}

async function insertVariant(trx: Tx, tenantId: string, actor: AuditActor, product: { id: string; name_ar: string | null; name_en: string | null }, v: VariantIn, isDefault: boolean, sort: number, branchId: string) {
  const row = await trx.insertInto('product_variants').values({
    tenant_id: tenantId, product_id: product.id, name_ar: v.name_ar ?? null, name_en: v.name_en ?? null,
    sku: v.sku ?? null, barcode: v.barcode ?? null, price_minor: v.price_minor, cost_minor: v.cost_minor ?? null,
    is_default: isDefault, is_active: isDefault ? true : (v.is_active ?? true), sort,
  }).returning('id').executeTakeFirstOrThrow();
  const item = await trx.insertInto('inventory_items').values({
    tenant_id: tenantId, branch_id: branchId, variant_id: row.id, name: itemName(product, v), kind: 'retail', unit: 'piece',
    low_stock_threshold: v.low_stock_threshold ?? null, cost_per_unit_minor: v.cost_minor ?? null,
  }).returning('id').executeTakeFirstOrThrow();
  if (v.initial_stock && v.initial_stock > 0) {
    await moveStock(trx, tenantId, item.id, { kind: 'receipt', quantity: v.initial_stock, dOnHand: v.initial_stock, dReserved: 0, reason: 'opening stock', actorUserId: actor.userId });
  }
  return row.id;
}

// ── Read ────────────────────────────────────────────────────────────────────
export async function listProducts(access: TenantAccess, query: z.infer<typeof productListQuery>) {
  return withTenant(access.tenantId, async (trx) => {
    const branchId = await primaryBranchId(trx, access.tenantId);
    const avail = sql<number>`(select coalesce(sum(ii.on_hand - ii.reserved), 0)::float8 from product_variants v join inventory_items ii on ii.variant_id = v.id and ii.branch_id = ${branchId} where v.product_id = p.id and v.is_active)`;
    const low = sql<boolean>`exists (select 1 from product_variants v join inventory_items ii on ii.variant_id = v.id and ii.branch_id = ${branchId} where v.product_id = p.id and v.is_active and ii.low_stock_threshold is not null and ii.on_hand - ii.reserved <= ii.low_stock_threshold)`;
    let q = trx.selectFrom('products as p')
      .leftJoin('product_variants as dv', (j) => j.onRef('dv.product_id', '=', 'p.id').on('dv.is_default', '=', true))
      .leftJoin('categories as c', 'c.id', 'p.category_id')
      .where('p.tenant_id', '=', access.tenantId);
    const status = query.status ?? 'all_live';
    if (status === 'all_live') q = q.where('p.status', '<>', 'archived');
    else if (status !== 'all') q = q.where('p.status', '=', status);
    if (query.category_id) q = q.where('p.category_id', '=', query.category_id);
    if (query.q) {
      const like = `%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      q = q.where((eb) => eb.or([
        eb('p.name_ar', 'ilike', like), eb('p.name_en', 'ilike', like),
        eb.exists(eb.selectFrom('product_variants as sv').select('sv.id').whereRef('sv.product_id', '=', 'p.id')
          .where((e2) => e2.or([e2('sv.sku', 'ilike', like), e2('sv.barcode', 'ilike', like), e2('sv.name_ar', 'ilike', like), e2('sv.name_en', 'ilike', like)]))),
      ]));
    }
    if (query.stock === 'out') q = q.where(sql<boolean>`${avail} <= 0`);
    if (query.stock === 'in') q = q.where(sql<boolean>`${avail} > 0`);
    if (query.stock === 'low') q = q.where(low);
    const dir = query.dir ?? (query.sort === 'created' || !query.sort ? 'desc' : 'asc');
    const orderExpr = query.sort === 'name' ? sql`coalesce(p.name_ar, p.name_en)`
      : query.sort === 'price' ? sql`dv.price_minor`
        : query.sort === 'stock' ? avail : sql`p.created_at`;
    const rows = await q.select([
      'p.id', 'p.name_ar', 'p.name_en', 'p.status', 'p.is_visible', 'p.hide_when_out_of_stock', 'p.max_per_order', 'p.category_id', 'p.created_at', 'p.version',
      'c.name_ar as category_name_ar', 'c.name_en as category_name_en',
      'dv.id as default_variant_id', 'dv.price_minor', 'dv.sku',
      avail.as('available'), low.as('low_stock'),
      sql<number>`(select count(*)::int from product_variants v where v.product_id = p.id and v.is_active)`.as('variant_count'),
      sql<string | null>`(select pi.asset_id from product_images pi where pi.product_id = p.id order by pi.sort limit 1)`.as('image_asset_id'),
      sql<number>`count(*) over ()`.as('total'),
    ]).orderBy(orderExpr, dir).orderBy('p.id').limit(query.limit).offset(query.offset).execute();
    return { items: rows.map(({ total: _t, ...r }) => r), total: Number(rows[0]?.total ?? 0) };
  });
}

export async function loadProduct(trx: Tx, access: TenantAccess, id: string) {
  const p = await trx.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirst();
  if (!p) throw Errors.notFound('product');
  const branchId = await primaryBranchId(trx, access.tenantId);
  const variants = await trx.selectFrom('product_variants as v')
    .leftJoin('inventory_items as ii', (j) => j.onRef('ii.variant_id', '=', 'v.id').on('ii.branch_id', '=', branchId))
    .select(['v.id', 'v.name_ar', 'v.name_en', 'v.sku', 'v.barcode', 'v.price_minor', 'v.cost_minor', 'v.is_default', 'v.is_active', 'v.sort',
      'ii.id as inventory_item_id', 'ii.on_hand', 'ii.reserved', 'ii.low_stock_threshold', 'ii.kind as inventory_kind'])
    .where('v.product_id', '=', id).orderBy('v.is_default', 'desc').orderBy('v.sort').execute();
  const images = await trx.selectFrom('product_images').select(['asset_id', 'sort']).where('product_id', '=', id).orderBy('sort').execute();
  const showCost = canSeeCosts(access);
  return {
    ...p,
    image_asset_ids: images.map((i) => i.asset_id),
    variants: variants.map(({ cost_minor, ...v }) => ({
      ...v,
      on_hand: Number(v.on_hand ?? 0), reserved: Number(v.reserved ?? 0), available: Number(v.on_hand ?? 0) - Number(v.reserved ?? 0),
      low_stock: v.low_stock_threshold != null && Number(v.on_hand ?? 0) - Number(v.reserved ?? 0) <= Number(v.low_stock_threshold),
      ...(showCost ? { cost_minor } : {}),
    })),
  };
}

export async function getProduct(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, (trx) => loadProduct(trx, access, id));
}

// ── Write ───────────────────────────────────────────────────────────────────
export async function createProduct(access: TenantAccess, actor: AuditActor, input: ProductInput) {
  assertCostsAllowed(access, input.variants);
  return withTenant(access.tenantId, async (trx) => {
    // Serialize product creation per tenant so the plan limit cannot be raced.
    await sql`select pg_advisory_xact_lock(hashtext(${`products:${access.tenantId}`}))`.execute(trx);
    requireWithinLimit(access, 'limit.products', await countActiveProducts(trx, access.tenantId));
    await assertProductCategory(trx, input.category_id);
    const max = await trx.selectFrom('products').select(sql<number>`coalesce(max(sort), -1)::int`.as('m')).where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
    const p = await trx.insertInto('products').values({
      tenant_id: access.tenantId, name_ar: input.name_ar ?? null, name_en: input.name_en ?? null,
      description_ar: input.description_ar ?? null, description_en: input.description_en ?? null, category_id: input.category_id ?? null,
      status: input.status ?? 'active', is_visible: input.is_visible ?? true, hide_when_out_of_stock: input.hide_when_out_of_stock ?? false,
      max_per_order: input.max_per_order ?? 10, returnable: input.returnable ?? true, sort: max.m + 1,
    }).returning(['id', 'name_ar', 'name_en']).executeTakeFirstOrThrow();
    const branchId = await primaryBranchId(trx, access.tenantId);
    for (const [i, v] of input.variants.entries()) await insertVariant(trx, access.tenantId, actor, p, v, i === 0, i, branchId);
    if (input.image_asset_ids) await setImages(trx, access.tenantId, p.id, input.image_asset_ids);
    await audit(trx, actor, 'product.created', { tenantId: access.tenantId, targetType: 'product', targetId: p.id, data: { variants: input.variants.length, price_minor: input.variants[0]!.price_minor } });
    return loadProduct(trx, access, p.id);
  });
}

export async function updateProduct(access: TenantAccess, actor: AuditActor, id: string, patch: ProductPatch) {
  assertCostsAllowed(access, patch.variants);
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('products').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('product');
    if (cur.version !== patch.version) throw Errors.versionConflict(cur.version);
    if (patch.category_id !== undefined) await assertProductCategory(trx, patch.category_id);
    const { version: _v, variants, image_asset_ids, ...fields } = patch;
    if (cur.status === 'archived' && fields.status) throw Errors.conflict('product_archived', 'Restore the product first');
    const next = { name_ar: fields.name_ar !== undefined ? fields.name_ar : cur.name_ar, name_en: fields.name_en !== undefined ? fields.name_en : cur.name_en };
    if (!next.name_ar && !next.name_en) throw Errors.validation([{ path: 'name_ar', code: 'custom', message: 'A name is required' }]);
    await trx.updateTable('products').set({ ...fields, version: cur.version + 1 }).where('id', '=', id).execute();
    if (image_asset_ids) await setImages(trx, access.tenantId, id, image_asset_ids);

    const priceChanges: Array<{ variant_id: string; from: number; to: number }> = [];
    if (variants) {
      const existing = await trx.selectFrom('product_variants').selectAll().where('product_id', '=', id).execute();
      const byId = new Map(existing.map((v) => [v.id, v]));
      for (const v of variants) if (v.id && !byId.has(v.id)) throw Errors.notFound('variant');
      const keep = new Set(variants.filter((v) => v.id).map((v) => v.id!));
      const def = existing.find((v) => v.is_default);
      if (def && !keep.has(def.id)) throw Errors.invalid('default_variant_required', 'The default variant cannot be removed');
      const branchId = await primaryBranchId(trx, access.tenantId);
      for (const [i, v] of variants.entries()) {
        if (v.id) {
          const old = byId.get(v.id)!;
          if (old.is_default && v.is_active === false) throw Errors.invalid('default_variant_required', 'The default variant cannot be deactivated');
          if (old.price_minor !== v.price_minor) priceChanges.push({ variant_id: v.id, from: old.price_minor, to: v.price_minor });
          await trx.updateTable('product_variants').set({
            name_ar: v.name_ar ?? null, name_en: v.name_en ?? null, sku: v.sku ?? null, barcode: v.barcode ?? null,
            price_minor: v.price_minor, is_active: old.is_default ? true : (v.is_active ?? true), sort: i,
            ...(v.cost_minor !== undefined ? { cost_minor: v.cost_minor } : {}),
          }).where('id', '=', v.id).execute();
          await trx.updateTable('inventory_items').set({
            name: itemName(next, v),
            ...(v.low_stock_threshold !== undefined ? { low_stock_threshold: v.low_stock_threshold } : {}),
            ...(v.cost_minor !== undefined ? { cost_per_unit_minor: v.cost_minor } : {}),
          }).where('variant_id', '=', v.id).execute();
        } else {
          await insertVariant(trx, access.tenantId, actor, { id, ...next }, v, false, i, branchId);
        }
      }
      // Omitted variants are deactivated (order history keeps referencing them).
      const drop = existing.filter((v) => !keep.has(v.id) && v.is_active).map((v) => v.id);
      if (drop.length) await trx.updateTable('product_variants').set({ is_active: false }).where('id', 'in', drop).execute();
    }
    await audit(trx, actor, 'product.updated', { tenantId: access.tenantId, targetType: 'product', targetId: id, data: { fields: Object.keys(fields), price_changes: priceChanges } });
    return loadProduct(trx, access, id);
  });
}

export async function archiveProduct(access: TenantAccess, actor: AuditActor, id: string, archived: boolean) {
  return withTenant(access.tenantId, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`products:${access.tenantId}`}))`.execute(trx);
    const cur = await trx.selectFrom('products').select(['status', 'version']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('product');
    if (!archived && cur.status === 'archived') requireWithinLimit(access, 'limit.products', await countActiveProducts(trx, access.tenantId));
    const status = archived ? 'archived' : (cur.status === 'archived' ? 'draft' : cur.status);
    await trx.updateTable('products').set({ status, version: cur.version + 1 }).where('id', '=', id).execute();
    await audit(trx, actor, archived ? 'product.archived' : 'product.restored', { tenantId: access.tenantId, targetType: 'product', targetId: id });
    return loadProduct(trx, access, id);
  });
}

/**
 * Public availability for storefront product pages (no costs). Returns only
 * active variants of active, visible products; `purchasable` is false when out
 * of stock, and `hidden` is true when the product hides itself when out of stock.
 */
export async function publicVariantAvailability(trx: Tx, tenantId: string, variantIds: string[]) {
  if (!variantIds.length) return [];
  const branchId = await primaryBranchId(trx, tenantId);
  const rows = await trx.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id')
    .leftJoin('inventory_items as ii', (j) => j.onRef('ii.variant_id', '=', 'v.id').on('ii.branch_id', '=', branchId))
    .select(['v.id', 'v.product_id', 'v.price_minor', 'p.max_per_order', 'p.hide_when_out_of_stock', 'ii.on_hand', 'ii.reserved', 'ii.is_active as item_active'])
    .where('v.tenant_id', '=', tenantId).where('v.id', 'in', variantIds).where('v.is_active', '=', true)
    .where('p.status', '=', 'active').where('p.is_visible', '=', true).execute();
  return rows.map((r) => {
    const available = r.item_active ? Math.max(0, Number(r.on_hand ?? 0) - Number(r.reserved ?? 0)) : 0;
    return { variant_id: r.id, product_id: r.product_id, price_minor: r.price_minor, max_per_order: r.max_per_order, available, purchasable: available >= 1, hidden: r.hide_when_out_of_stock && available < 1 };
  });
}
