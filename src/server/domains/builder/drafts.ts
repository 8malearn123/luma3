import type { Tx } from '../../db/client';
import { DEFAULT_LAYOUT, migrateBlock, zLayout, type PageBlock, type SiteLayout } from '@/shared/builder/blocks';
import type { PageKind, SiteSnapshot, SnapshotPage } from '@/shared/builder/storefront';
import { readBrand } from './brand';

export type DraftPage = SnapshotPage & { status: 'active' | 'archived'; version: number; updated_at: Date; draft_updated_by: string | null };

export async function readLayout(trx: Tx, tenantId: string): Promise<{ layout: SiteLayout; version: number }> {
  const r = await trx.selectFrom('site_drafts').select(['layout', 'version']).where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!r) return { layout: DEFAULT_LAYOUT, version: 0 };
  const parsed = zLayout.safeParse(r.layout);
  return { layout: parsed.success ? parsed.data : DEFAULT_LAYOUT, version: r.version };
}

/** All pages (active and archived) with their draft blocks and versions. */
export async function readDraftPages(trx: Tx, tenantId: string, opts: { includeArchived?: boolean } = {}): Promise<DraftPage[]> {
  let q = trx.selectFrom('store_pages as p').innerJoin('page_drafts as d', (j) => j.onRef('d.page_id', '=', 'p.id').onRef('d.tenant_id', '=', 'p.tenant_id'))
    .select(['p.id', 'p.kind', 'p.slug', 'p.title_ar', 'p.title_en', 'p.show_in_nav', 'p.show_in_footer', 'p.sort', 'p.status', 'd.blocks', 'd.version', 'd.updated_at', 'd.updated_by'])
    .where('p.tenant_id', '=', tenantId);
  if (!opts.includeArchived) q = q.where('p.status', '=', 'active');
  const rows = await q.orderBy('p.sort').orderBy('p.created_at').execute();
  return rows.map((r) => ({
    id: r.id, kind: r.kind as PageKind, slug: r.slug, title_ar: r.title_ar, title_en: r.title_en, show_in_nav: r.show_in_nav,
    show_in_footer: r.show_in_footer, sort: r.sort, status: r.status as 'active' | 'archived',
    blocks: Array.isArray(r.blocks) ? (r.blocks as PageBlock[]) : [], version: r.version, updated_at: r.updated_at, draft_updated_by: r.updated_by,
  }));
}

/** The current draft as a snapshot document (what publishing would freeze). */
export async function readDraftSnapshot(trx: Tx, tenantId: string): Promise<SiteSnapshot> {
  const [{ brand }, { layout }, pages] = await Promise.all([readBrand(trx, tenantId), readLayout(trx, tenantId), readDraftPages(trx, tenantId)]);
  return {
    schema_version: 1, brand, layout,
    pages: pages.map(({ status: _s, version: _v, updated_at: _u, draft_updated_by: _b, ...p }) => ({ ...p, blocks: safeBlocks(p.blocks) })),
  };
}

/** Runs registry migrations; drops malformed entries instead of breaking the page. */
export function safeBlocks(blocks: unknown): PageBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => b && typeof b === 'object' && typeof (b as PageBlock).type === 'string' && typeof (b as PageBlock).id === 'string')
    .map((b) => { try { return migrateBlock(b as PageBlock); } catch { return null; } })
    .filter((b): b is PageBlock => !!b);
}
