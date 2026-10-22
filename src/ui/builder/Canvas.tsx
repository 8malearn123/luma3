'use client';

import type { CSSProperties, MouseEvent } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, ArrowDown, ArrowUp, Copy, Eye, EyeOff, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { cx } from '../components/cx';
import { BLOCKS, type PageBlock } from '@/shared/builder/blocks';
import type { SnapshotPage, StorefrontData } from '@/shared/builder/storefront';
import { deviceHidden, RenderBlock } from '../storefront/BlockRenderer';
import { StorefrontShell } from '../storefront/StorefrontShell';
import type { RenderCtx } from '../storefront/context';
import type { RefWarning } from './types';

type Props = {
  data: StorefrontData;
  page: SnapshotPage;
  blocks: PageBlock[];
  device: 'desktop' | 'mobile';
  selected: string | null;
  warnings: RefWarning[];
  onSelect: (id: string | null) => void;
  onMove: (id: string, delta: number) => void;
  onDuplicate: (id: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onAddAt: (index: number) => void;
};

function CanvasBlock({ block, index, count, ctx, pageBlocks, p }: { block: PageBlock; index: number; count: number; ctx: RenderCtx; pageBlocks: PageBlock[]; p: Props }) {
  const { t, locale } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const selected = p.selected === block.id || block.children?.some((c) => c.id === p.selected);
  const label = BLOCKS[block.type]?.label[locale] ?? block.type;
  const warn = p.warnings.filter((w) => w.blockId === block.id || block.children?.some((c) => c.id === w.blockId));
  const hidden = !block.visibility.enabled;
  const offDevice = deviceHidden(ctx, block);
  return (
    <div ref={setNodeRef} style={style} data-block-id={block.id}
      className={cx('group relative outline-offset-[-2px]', selected ? 'outline-2 outline-luma-500 outline' : 'hover:outline hover:outline-1 hover:outline-luma-300', isDragging && 'z-10 opacity-60')}
      onClick={(e) => { e.stopPropagation(); p.onSelect(block.id); }}>
      <div className={cx('absolute start-2 top-2 z-20 flex items-center gap-0.5 rounded-lg border border-line bg-white/95 p-0.5 text-ink shadow-sm',
        selected ? 'flex' : 'hidden group-hover:flex group-focus-within:flex')} onClick={(e) => e.stopPropagation()}>
        <button ref={setActivatorNodeRef} {...attributes} {...listeners} type="button" className="cursor-grab rounded p-1 hover:bg-luma-100 active:cursor-grabbing"
          aria-label={t('builder.canvas.drag', { name: label })} aria-roledescription={t('builder.canvas.sortable')}>
          <GripVertical className="size-4" aria-hidden />
        </button>
        <span className="px-1 text-xs font-medium">{label}</span>
        <button type="button" className="rounded p-1 hover:bg-luma-100 disabled:opacity-30" disabled={index === 0} onClick={() => p.onMove(block.id, -1)} aria-label={t('builder.canvas.move_up')} title={t('builder.canvas.move_up')}><ArrowUp className="size-4" /></button>
        <button type="button" className="rounded p-1 hover:bg-luma-100 disabled:opacity-30" disabled={index === count - 1} onClick={() => p.onMove(block.id, 1)} aria-label={t('builder.canvas.move_down')} title={t('builder.canvas.move_down')}><ArrowDown className="size-4" /></button>
        <button type="button" className="rounded p-1 hover:bg-luma-100" onClick={() => p.onDuplicate(block.id)} aria-label={t('builder.canvas.duplicate')} title={t('builder.canvas.duplicate')}><Copy className="size-4" /></button>
        <button type="button" className="rounded p-1 hover:bg-luma-100" onClick={() => p.onToggle(block.id)} aria-label={hidden ? t('builder.canvas.show') : t('builder.canvas.hide')} title={hidden ? t('builder.canvas.show') : t('builder.canvas.hide')}>{hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}</button>
        <button type="button" className="rounded p-1 text-danger hover:bg-danger-bg" onClick={() => p.onDelete(block.id)} aria-label={t('builder.canvas.delete')} title={t('builder.canvas.delete')}><Trash2 className="size-4" /></button>
      </div>
      {warn.length ? (
        <span className="absolute end-2 top-2 z-20 inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-xs text-warn" title={t('builder.warnings.block')}>
          <AlertTriangle className="size-3.5" aria-hidden />{t('builder.warnings.count', { n: warn.length })}
        </span>
      ) : null}
      {hidden || offDevice ? <span className="absolute bottom-2 end-2 z-20 rounded-full bg-ink/80 px-2 py-0.5 text-xs text-white">{hidden ? t('builder.canvas.hidden_badge') : t('builder.canvas.device_hidden')}</span> : null}
      <div className={cx((hidden || offDevice) && 'opacity-40')}>
        <RenderBlock ctx={ctx} block={block} pageBlocks={pageBlocks} first={index === 0} />
      </div>
    </div>
  );
}

function DropZone({ id, label, onClick }: { id: string; label: string; onClick: () => void }) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={cx('mx-4 my-3 rounded-xl border-2 border-dashed p-4 text-center text-sm transition-colors', isOver ? 'border-luma-500 bg-luma-50 text-luma-800' : 'border-luma-200 text-ink-muted')}>
      <button type="button" onClick={onClick} className="inline-flex items-center gap-1 font-medium hover:underline"><Plus className="size-4" aria-hidden />{label}</button>
    </div>
  );
}

/**
 * Canvas: renders the draft with the SAME storefront components and live
 * catalog data. Links are disabled (clicking selects the block).
 */
export function Canvas(p: Props) {
  const { t, locale } = useI18n();
  const ctx: RenderCtx = { data: { ...p.data, pages: p.data.pages.map((x) => (x.id === p.page.id ? { ...x, blocks: p.blocks } : x)) }, locale, canvas: true, device: p.device };
  const stopLinks = (e: MouseEvent) => { if ((e.target as HTMLElement).closest('a,button[type="submit"]') && !(e.target as HTMLElement).closest('[data-builder-ui]')) e.preventDefault(); };
  return (
    <div className={cx('mx-auto overflow-hidden rounded-xl border border-line bg-white shadow-sm transition-[max-width]', p.device === 'mobile' ? 'max-w-[400px]' : 'max-w-full')}
      onClickCapture={stopLinks} onClick={() => p.onSelect(null)} aria-label={t('builder.canvas.label')} role="region">
      <div>
        <StorefrontShell ctx={ctx}>
          <SortableContext items={p.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            {p.blocks.length === 0 ? <p className="p-8 text-center text-sm text-sf-muted">{t('builder.canvas.empty_page')}</p> : null}
            {p.blocks.map((b, i) => <CanvasBlock key={b.id} block={b} index={i} count={p.blocks.length} ctx={ctx} pageBlocks={p.blocks} p={p} />)}
          </SortableContext>
          <div data-builder-ui><DropZone id="canvas-end" label={t('builder.canvas.add_here')} onClick={() => p.onAddAt(p.blocks.length)} /></div>
        </StorefrontShell>
      </div>
      <span className="sr-only" lang={locale}>{t('builder.canvas.instructions')}</span>
    </div>
  );
}
