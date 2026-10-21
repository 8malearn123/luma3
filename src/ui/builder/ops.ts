import { BLOCKS, makeBlock, MAX_BLOCKS_PER_PAGE, MAX_CHILDREN, newBlockId, type BlockType, type PageBlock } from '@/shared/builder/blocks';
import type { BuilderPage, CatalogRefs } from './types';

/** Pure block-tree operations used by the editor (and its undo history). */

export function findBlock(list: PageBlock[], id: string): { block: PageBlock; parent: PageBlock | null } | null {
  for (const b of list) {
    if (b.id === id) return { block: b, parent: null };
    for (const c of b.children ?? []) if (c.id === id) return { block: c, parent: b };
  }
  return null;
}

export function updateBlock(list: PageBlock[], id: string, fn: (b: PageBlock) => PageBlock): PageBlock[] {
  return list.map((b) => {
    if (b.id === id) return fn(b);
    if (b.children?.some((c) => c.id === id)) return { ...b, children: b.children.map((c) => (c.id === id ? fn(c) : c)) };
    return b;
  });
}

export function removeBlock(list: PageBlock[], id: string): PageBlock[] {
  return list.filter((b) => b.id !== id).map((b) => (b.children?.some((c) => c.id === id) ? { ...b, children: b.children.filter((c) => c.id !== id) } : b));
}

export function cloneWithIds(b: PageBlock): PageBlock {
  return { ...structuredClone(b), id: newBlockId(), ...(b.children ? { children: b.children.map(cloneWithIds) } : {}) };
}

export function duplicateBlock(list: PageBlock[], id: string): { list: PageBlock[]; newId: string | null } {
  const top = list.findIndex((b) => b.id === id);
  if (top >= 0) {
    const copy = cloneWithIds(list[top]!);
    return { list: [...list.slice(0, top + 1), copy, ...list.slice(top + 1)], newId: copy.id };
  }
  let newId: string | null = null;
  const next = list.map((b) => {
    const i = b.children?.findIndex((c) => c.id === id) ?? -1;
    if (i < 0 || !b.children || b.children.length >= MAX_CHILDREN) return b;
    const copy = cloneWithIds(b.children[i]!);
    newId = copy.id;
    return { ...b, children: [...b.children.slice(0, i + 1), copy, ...b.children.slice(i + 1)] };
  });
  return { list: next, newId };
}

export function moveBlock(list: PageBlock[], id: string, delta: number): PageBlock[] {
  const i = list.findIndex((b) => b.id === id);
  if (i >= 0) {
    const j = i + delta;
    if (j < 0 || j >= list.length) return list;
    const out = [...list];
    const [m] = out.splice(i, 1);
    out.splice(j, 0, m!);
    return out;
  }
  return list.map((b) => {
    const k = b.children?.findIndex((c) => c.id === id) ?? -1;
    if (k < 0 || !b.children) return b;
    const j = k + delta;
    if (j < 0 || j >= b.children.length) return b;
    const ch = [...b.children];
    const [m] = ch.splice(k, 1);
    ch.splice(j, 0, m!);
    return { ...b, children: ch };
  });
}

export function countBlocks(list: PageBlock[]) {
  const byType = new Map<BlockType, number>();
  let total = 0;
  const walk = (l: PageBlock[]) => l.forEach((b) => { total++; byType.set(b.type, (byType.get(b.type) ?? 0) + 1); if (b.children) walk(b.children); });
  walk(list);
  return { total, byType };
}

export type AddCheck = { ok: true } | { ok: false; reason: 'limit_type' | 'limit_total' | 'needs_service' | 'needs_product' | 'needs_page' | 'feature' };

export function canAdd(type: BlockType, list: PageBlock[], refs: CatalogRefs, pages: BuilderPage[], productsEnabled: boolean): AddCheck {
  const d = BLOCKS[type];
  const { total, byType } = countBlocks(list);
  if (d.feature === 'feature.products' && !productsEnabled) return { ok: false, reason: 'feature' };
  if (total >= MAX_BLOCKS_PER_PAGE) return { ok: false, reason: 'limit_total' };
  if ((byType.get(type) ?? 0) >= d.maxPerPage) return { ok: false, reason: 'limit_type' };
  if (type === 'service_feature' && !refs.services.some((s) => !s.archived)) return { ok: false, reason: 'needs_service' };
  if (type === 'product_feature' && !refs.products.some((s) => !s.archived)) return { ok: false, reason: 'needs_product' };
  if (type === 'page_link' && !pages.some((p) => p.status === 'active' && p.kind !== 'home')) return { ok: false, reason: 'needs_page' };
  return { ok: true };
}

/** New block with required references pre-filled so it is valid from the first save. */
export function newBlock(type: BlockType, refs: CatalogRefs, pages: BuilderPage[]): PageBlock {
  const b = makeBlock(type);
  if (type === 'service_feature') b.props = { ...b.props, service_id: refs.services.find((s) => !s.archived && s.is_visible)?.id ?? refs.services[0]?.id };
  if (type === 'product_feature') b.props = { ...b.props, product_id: refs.products.find((s) => !s.archived)?.id ?? refs.products[0]?.id };
  if (type === 'page_link') b.props = { ...b.props, page_id: (pages.find((p) => p.kind === 'custom' && p.status === 'active') ?? pages.find((p) => p.kind === 'about'))?.id };
  if (['hero', 'cta', 'welcome'].includes(type)) b.action = { type: 'start_booking' };
  return b;
}

export function insertAt(list: PageBlock[], block: PageBlock, index: number) {
  const i = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, i), block, ...list.slice(i)];
}
