import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import type { TenantAccess } from '../../tenancy/access';
import type { PortfolioItemInput } from '@/shared/schemas/portfolio';

/**
 * Portfolio («أعمالي» for experts, «معرض الأعمال» for salons): before/after
 * pairs (or a single "after" image). The storefront's before/after block can
 * show these items, filtered by category, instead of hand-picked images.
 * Only this tenant's public, ready images can be used.
 */

async function assertPublicAssets(trx: Tx, tenantId: string, ids: Array<string | null | undefined>) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return;
  const rows = await trx.selectFrom('assets').select('id').where('tenant_id', '=', tenantId).where('id', 'in', list)
    .where('status', '=', 'ready').where('visibility', '=', 'public').execute();
  if (rows.length !== list.length) throw Errors.invalid('invalid_asset', 'An image is missing or belongs to another business');
}

const COLS = ['id', 'before_asset_id', 'after_asset_id', 'caption_ar', 'caption_en', 'category', 'service_id', 'is_visible', 'sort', 'created_at', 'updated_at'] as const;

export async function listPortfolio(tenantId: string) {
  return withTenant(tenantId, (trx) => trx.selectFrom('portfolio_items').select([...COLS]).orderBy('sort').orderBy('created_at').execute());
}

function values(input: Partial<PortfolioItemInput>) {
  const v: Record<string, unknown> = {};
  if (input.before_asset_id !== undefined) v.before_asset_id = input.before_asset_id;
  if (input.after_asset_id !== undefined) v.after_asset_id = input.after_asset_id;
  if (input.caption_ar !== undefined) v.caption_ar = input.caption_ar?.trim() || null;
  if (input.caption_en !== undefined) v.caption_en = input.caption_en?.trim() || null;
  if (input.category !== undefined) v.category = input.category?.trim() || null;
  if (input.service_id !== undefined) v.service_id = input.service_id;
  if (input.is_visible !== undefined) v.is_visible = input.is_visible;
  if (input.sort !== undefined) v.sort = input.sort;
  return v;
}

export async function createPortfolioItem(access: TenantAccess, actor: AuditActor, input: PortfolioItemInput) {
  return withTenant(access.tenantId, async (trx) => {
    await assertPublicAssets(trx, access.tenantId, [input.before_asset_id, input.after_asset_id]);
    if (input.service_id) {
      const s = await trx.selectFrom('services').select('id').where('id', '=', input.service_id).where('archived_at', 'is', null).executeTakeFirst();
      if (!s) throw Errors.invalid('service_unavailable');
    }
    const count = await trx.selectFrom('portfolio_items').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    if (Number(count.n) >= 300) throw Errors.invalid('portfolio_full', 'At most 300 portfolio items');
    const row = await trx.insertInto('portfolio_items').values({
      tenant_id: access.tenantId, after_asset_id: input.after_asset_id, ...values(input), created_by: actor.userId,
    } as never).returning([...COLS]).executeTakeFirstOrThrow();
    await audit(trx, actor, 'portfolio.created', { tenantId: access.tenantId, targetType: 'portfolio_item', targetId: row.id });
    return row;
  });
}

export async function updatePortfolioItem(access: TenantAccess, actor: AuditActor, id: string, input: Partial<PortfolioItemInput>) {
  return withTenant(access.tenantId, async (trx) => {
    await assertPublicAssets(trx, access.tenantId, [input.before_asset_id, input.after_asset_id]);
    const v = values(input);
    if (!Object.keys(v).length) throw Errors.invalid('nothing_to_update');
    const row = await trx.updateTable('portfolio_items').set(v as never).where('id', '=', id).returning([...COLS]).executeTakeFirst();
    if (!row) throw Errors.notFound('portfolio_item');
    await audit(trx, actor, 'portfolio.updated', { tenantId: access.tenantId, targetType: 'portfolio_item', targetId: id, data: { fields: Object.keys(v) } });
    return row;
  });
}

export async function deletePortfolioItem(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const row = await trx.deleteFrom('portfolio_items').where('id', '=', id).returning('id').executeTakeFirst();
    if (!row) throw Errors.notFound('portfolio_item');
    await audit(trx, actor, 'portfolio.deleted', { tenantId: access.tenantId, targetType: 'portfolio_item', targetId: id });
    return row;
  });
}

/** Public read model: visible items only (allowlisted fields). */
export async function loadPublicPortfolio(trx: Tx, tenantId: string) {
  return trx.selectFrom('portfolio_items').select(['id', 'before_asset_id', 'after_asset_id', 'caption_ar', 'caption_en', 'category'])
    .where('tenant_id', '=', tenantId).where('is_visible', '=', true).orderBy('sort').orderBy('created_at').limit(120).execute();
}
