'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cx } from '../../components/cx';
import type { PublicAsset } from '@/shared/builder/storefront';
import { cols } from './common';

type Item = { id: string; alt: string; caption: string };

/** Portfolio grid with a keyboard-accessible lightbox (Escape closes, arrows navigate, focus is trapped and restored). */
export function GalleryGrid({ items, layout, columns, lightbox, labels, rtl, assets }: {
  items: Item[]; layout: string; columns: number; lightbox: boolean; rtl: boolean; assets: Record<string, PublicAsset>;
  labels: { open: string; close: string; next: string; prev: string; of: string };
}) {
  const [open, setOpen] = useState<number | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = useCallback(() => { setOpen(null); opener.current?.focus(); }, []);
  const step = useCallback((d: number) => setOpen((i) => (i === null ? i : (i + d + items.length) % items.length)), [items.length]);

  useEffect(() => {
    if (open === null) return;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'ArrowRight') step(rtl ? -1 : 1);
      if (e.key === 'ArrowLeft') step(rtl ? 1 : -1);
      if (e.key === 'Tab') {
        const f = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button') ?? []);
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, close, step, rtl]);

  const carousel = layout === 'carousel';
  const masonry = layout === 'masonry';
  const img = (it: Item, i: number) => {
    const a = assets[it.id];
    // eslint-disable-next-line @next/next/no-img-element
    const el = <img src={`/api/v1/media/${it.id}`} alt={it.alt} width={a?.width ?? undefined} height={a?.height ?? undefined} loading="lazy" decoding="async"
      style={masonry ? undefined : { aspectRatio: '1 / 1' }} className={cx('block w-full rounded-sf object-cover', masonry && 'h-auto')} />;
    return lightbox ? (
      <button type="button" className="block w-full cursor-zoom-in" aria-label={`${labels.open}: ${it.alt || i + 1}`} onClick={(e) => { opener.current = e.currentTarget; setOpen(i); }}>{el}</button>
    ) : el;
  };

  return (
    <>
      {carousel ? (
        <ul className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
          {items.map((it, i) => <li key={it.id + i} className="w-3/4 shrink-0 snap-start @2xl:w-1/3"><figure>{img(it, i)}{it.caption ? <figcaption className="mt-1 text-sm text-sf-muted">{it.caption}</figcaption> : null}</figure></li>)}
        </ul>
      ) : masonry ? (
        <ul className="gap-3 [column-fill:_balance]" style={{ columnCount: Math.min(columns, 3) }}>
          {items.map((it, i) => <li key={it.id + i} className="mb-3 break-inside-avoid"><figure>{img(it, i)}{it.caption ? <figcaption className="mt-1 text-sm text-sf-muted">{it.caption}</figcaption> : null}</figure></li>)}
        </ul>
      ) : (
        <ul className={cx('grid gap-3', cols(columns))}>
          {items.map((it, i) => <li key={it.id + i}><figure>{img(it, i)}{it.caption ? <figcaption className="mt-1 text-sm text-sf-muted">{it.caption}</figcaption> : null}</figure></li>)}
        </ul>
      )}
      {open !== null && items[open] && typeof document !== 'undefined' ? createPortal(
        <div ref={dialog} dir={rtl ? 'rtl' : 'ltr'} role="dialog" aria-modal="true" aria-label={items[open]!.alt || labels.open} className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/90 p-4">
          <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3 text-white">
            <span className="text-sm" aria-live="polite">{open + 1} {labels.of} {items.length}</span>
            <button type="button" onClick={close} aria-label={labels.close} className="rounded-full p-2 hover:bg-white/10"><X className="size-6" /></button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/v1/media/${items[open]!.id}`} alt={items[open]!.alt} className="max-h-[80vh] max-w-full rounded object-contain" />
          {items[open]!.caption ? <p className="mt-3 text-center text-white/90">{items[open]!.caption}</p> : null}
          {items.length > 1 ? (
            <div className="mt-4 flex gap-3">
              <button type="button" onClick={() => step(-1)} aria-label={labels.prev} className="rounded-full bg-white/10 p-3 text-white hover:bg-white/20">{rtl ? <ChevronRight className="size-5" /> : <ChevronLeft className="size-5" />}</button>
              <button type="button" onClick={() => step(1)} aria-label={labels.next} className="rounded-full bg-white/10 p-3 text-white hover:bg-white/20">{rtl ? <ChevronLeft className="size-5" /> : <ChevronRight className="size-5" />}</button>
            </div>
          ) : null}
        </div>
      , document.body) : null}
    </>
  );
}
