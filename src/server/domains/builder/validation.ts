import type { Tx } from '../../db/client';
import { BLOCKS, collectReferences, validateBlocks, zLayout, type BlockIssue, type PageBlock, type SiteLayout } from '@/shared/builder/blocks';
import { sanitizeBlocks } from './sanitize';

export type RefWarning = { pageId: string | null; blockId: string | null; kind: string; targetId: string; code: 'archived' | 'hidden' | 'inactive' | 'missing_section' | 'wrong_kind' | 'feature_disabled' | 'broken_asset' };
export type PageIssue = BlockIssue & { pageId: string | null };

type Refs = ReturnType<typeof collectReferences>;

/**
 * Checks every catalog/page/asset reference against THIS tenant's rows.
 *  - An id that does not exist in this tenant (another tenant's id, or a
 *    made-up one) is an error: blocks can never point outside the business.
 *  - An id that exists but is archived/hidden/inactive is a warning: the
 *    builder warns the owner and the storefront shows a clear fallback.
 */
export async function checkReferences(trx: Tx, tenantId: string, pageId: string | null, blocks: PageBlock[], opts: { productsEnabled: boolean }) {
  const refs: Refs = collectReferences(blocks);
  const errors: PageIssue[] = [];
  const warnings: RefWarning[] = [];
  const owner = new Map<string, string | null>();
  const walk = (list: PageBlock[]) => list.forEach((b) => {
    const p = b.props as Record<string, any>;
    const ids: unknown[] = [p.image_asset_id, p.service_id, p.product_id, p.category_id, p.page_id, p.branch_id,
      ...(p.items ?? []).map((i: any) => i?.image_asset_id), ...(p.service_ids ?? []), ...(p.product_ids ?? []), ...(p.staff_ids ?? []),
      ...(p.package_ids ?? []), ...(p.page_ids ?? []), (b.action as any)?.targetId];
    for (const id of ids) if (typeof id === 'string' && !owner.has(id)) owner.set(id, b.id);
    if (b.children) walk(b.children);
  });
  walk(blocks);
  const err = (kind: string, id: string) => errors.push({ pageId, blockId: owner.get(id) ?? null, path: kind, code: 'invalid_reference', message: `${kind} ${id} does not belong to this business` });
  const warn = (kind: string, id: string, code: RefWarning['code']) => warnings.push({ pageId, blockId: owner.get(id) ?? null, kind, targetId: id, code });

  const list = (s: Set<string>) => [...s];
  if (refs.services.size) {
    const rows = await trx.selectFrom('services').select(['id', 'archived_at', 'is_active', 'is_visible']).where('tenant_id', '=', tenantId).where('id', 'in', list(refs.services)).execute();
    const m = new Map(rows.map((r) => [r.id, r]));
    for (const id of refs.services) {
      const r = m.get(id);
      if (!r) err('service', id);
      else if (r.archived_at) warn('service', id, 'archived');
      else if (!r.is_visible) warn('service', id, 'hidden');
      else if (!r.is_active) warn('service', id, 'inactive');
    }
  }
  if (refs.products.size) {
    const rows = await trx.selectFrom('products').select(['id', 'status', 'is_visible']).where('tenant_id', '=', tenantId).where('id', 'in', list(refs.products)).execute();
    const m = new Map(rows.map((r) => [r.id, r]));
    for (const id of refs.products) {
      const r = m.get(id);
      if (!r) err('product', id);
      else if (!opts.productsEnabled) warn('product', id, 'feature_disabled');
      else if (r.status === 'archived') warn('product', id, 'archived');
      else if (r.status !== 'active') warn('product', id, 'inactive');
      else if (!r.is_visible) warn('product', id, 'hidden');
    }
  }
  if (refs.categories.size) {
    const rows = await trx.selectFrom('categories').select(['id', 'archived_at', 'is_visible', 'kind']).where('tenant_id', '=', tenantId).where('id', 'in', list(refs.categories)).execute();
    const m = new Map(rows.map((r) => [r.id, r]));
    for (const id of refs.categories) {
      const r = m.get(id);
      if (!r) err('category', id);
      else if (r.archived_at) warn('category', id, 'archived');
      else if (!r.is_visible) warn('category', id, 'hidden');
    }
    // A service list filtered by a product category (or vice versa) shows nothing.
    const check = (list: PageBlock[]) => list.forEach((b) => {
      const cid = (b.props as any).category_id as string | null | undefined;
      const want = b.type === 'service_list' ? 'service' : b.type === 'product_grid' ? 'product' : null;
      const r = cid ? m.get(cid) : null;
      if (want && r && r.kind !== want) warnings.push({ pageId, blockId: b.id, kind: 'category', targetId: cid!, code: 'wrong_kind' });
      if (b.children) check(b.children);
    });
    check(blocks);
  }
  if (refs.staff.size) {
    const rows = await trx.selectFrom('staff_profiles').select(['id', 'archived_at', 'is_active', 'is_public']).where('tenant_id', '=', tenantId).where('id', 'in', list(refs.staff)).execute();
    const m = new Map(rows.map((r) => [r.id, r]));
    for (const id of refs.staff) {
      const r = m.get(id);
      if (!r) err('staff', id);
      else if (r.archived_at) warn('staff', id, 'archived');
      else if (!r.is_public) warn('staff', id, 'hidden');
      else if (!r.is_active) warn('staff', id, 'inactive');
    }
  }
  if (refs.pages.size) {
    const rows = await trx.selectFrom('store_pages').select(['id', 'status']).where('tenant_id', '=', tenantId).where('id', 'in', list(refs.pages)).execute();
    const m = new Map(rows.map((r) => [r.id, r]));
    for (const id of refs.pages) {
      const r = m.get(id);
      if (!r) err('page', id);
      else if (r.status !== 'active') warn('page', id, 'archived');
    }
  }
  if (refs.packages.size) {
    const rows = await trx.selectFrom('service_packages').select(['id', 'archived_at', 'is_active', 'is_visible']).where('tenant_id', '=', tenantId).where('id', 'in', list(refs.packages)).execute();
    const m = new Map(rows.map((r) => [r.id, r]));
    for (const id of refs.packages) {
      const r = m.get(id);
      if (!r) err('package', id);
      else if (r.archived_at) warn('package', id, 'archived');
      else if (!r.is_visible) warn('package', id, 'hidden');
      else if (!r.is_active) warn('package', id, 'inactive');
    }
  }
  if (refs.branches.size) {
    const rows = await trx.selectFrom('branches').select(['id', 'status']).where('tenant_id', '=', tenantId).where('id', 'in', list(refs.branches)).execute();
    const m = new Map(rows.map((r) => [r.id, r]));
    for (const id of refs.branches) {
      const r = m.get(id);
      if (!r) err('branch', id);
      else if (r.status !== 'active') warn('branch', id, 'archived');
    }
  }
  if (refs.assets.size) {
    const rows = await trx.selectFrom('assets').select(['id', 'status', 'visibility']).where('tenant_id', '=', tenantId).where('id', 'in', list(refs.assets)).execute();
    const m = new Map(rows.map((r) => [r.id, r]));
    for (const id of refs.assets) {
      const r = m.get(id);
      // Private assets (evidence/receipts) can never be placed on a public page.
      if (!r || r.visibility !== 'public') err('asset', id);
      else if (r.status !== 'ready') warn('asset', id, 'broken_asset');
    }
  }
  if (refs.sections.size) {
    const ids = new Set<string>();
    const all = (list: PageBlock[]) => list.forEach((b) => { ids.add(b.id); if (b.children) all(b.children); });
    all(blocks);
    for (const s of refs.sections) if (!ids.has(s)) warn('section', s, 'missing_section');
  }
  if (!opts.productsEnabled) {
    const each = (list: PageBlock[]) => list.forEach((b) => {
      if (BLOCKS[b.type]?.feature === 'feature.products') warnings.push({ pageId, blockId: b.id, kind: 'block', targetId: b.type, code: 'feature_disabled' });
      if (b.children) each(b.children);
    });
    each(blocks);
  }
  return { errors, warnings };
}

/**
 * Full validation for a page's blocks: registry structure (schemas, nesting,
 * limits, safe actions/URLs), text sanitisation and tenant reference checks.
 */
export async function validatePage(trx: Tx, tenantId: string, pageId: string | null, raw: unknown, opts: { productsEnabled: boolean }) {
  const structural = validateBlocks(raw);
  const issues: PageIssue[] = structural.issues.map((i) => ({ ...i, pageId }));
  if (issues.length) return { blocks: [] as PageBlock[], issues, warnings: [] as RefWarning[] };
  const blocks = sanitizeBlocks(structural.blocks);
  const refs = await checkReferences(trx, tenantId, pageId, blocks, opts);
  return { blocks, issues: refs.errors, warnings: refs.warnings };
}

export function parseLayout(raw: unknown): { layout: SiteLayout | null; issues: PageIssue[] } {
  const r = zLayout.safeParse(raw);
  if (r.success) return { layout: r.data, issues: [] };
  return { layout: null, issues: r.error.issues.slice(0, 20).map((i) => ({ pageId: null, blockId: null, path: `layout.${i.path.join('.')}`, code: 'invalid_layout', message: i.message })) };
}
