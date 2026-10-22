'use client';

import { useDraggable } from '@dnd-kit/core';
import {
  BadgePercent, BookOpenText, Clock, Columns3, FileText, GalleryHorizontal, Hand, CircleQuestionMark, Image, LayoutGrid, ListChecks, MapPin, Megaphone,
  MousePointerClick, PanelTop, Phone, Plus, SeparatorHorizontal, Share2, ShieldCheck, ShoppingBag, Sparkles, Square, Star, Tags, Type, Users, type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { cx } from '../components/cx';
import { BLOCKS, BLOCK_TYPES, type BlockDef, type BlockType } from '@/shared/builder/blocks';
import type { AddCheck } from './ops';

const CATEGORIES: BlockDef['category'][] = ['media', 'content', 'catalog', 'commerce', 'people', 'trust', 'info', 'layout'];

const ICONS: Record<string, LucideIcon> = {
  BadgePercent, BookOpenText, Clock, Columns3, FileText, GalleryHorizontal, Hand, CircleHelp: CircleQuestionMark, Image, LayoutGrid, ListChecks, MapPin, Megaphone,
  MousePointerClick, PanelTop, Phone, SeparatorHorizontal, Share2, ShieldCheck, ShoppingBag, Sparkles, Star, Tags, Type, Users,
};

export function BlockIcon({ name, className }: { name: string; className?: string }) {
  const I = ICONS[name] ?? Square;
  return <I className={className} aria-hidden />;
}

function Item({ type, check, onAdd }: { type: BlockType; check: AddCheck; onAdd: (t: BlockType) => void }) {
  const { t, locale } = useI18n();
  const d = BLOCKS[type];
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `lib:${type}`, disabled: !check.ok, data: { type } });
  const reason = check.ok ? null : t(`builder.library.cannot.${check.reason}`);
  return (
    <li className={cx('flex items-center gap-2 rounded-lg border border-line bg-white p-2 text-sm', isDragging && 'opacity-50', !check.ok && 'opacity-60')}>
      <span ref={setNodeRef} {...listeners} {...attributes} className={cx('flex min-w-0 flex-1 items-center gap-2', check.ok && 'cursor-grab active:cursor-grabbing')}
        aria-label={t('builder.library.drag', { name: d.label[locale] })} title={reason ?? t('builder.library.drag_hint')}>
        <BlockIcon name={d.icon} className="size-4 shrink-0 text-luma-700" />
        <span className="truncate">{d.label[locale]}</span>
      </span>
      <button type="button" disabled={!check.ok} onClick={() => onAdd(type)} title={reason ?? t('builder.library.add')}
        aria-label={`${t('builder.library.add')}: ${d.label[locale]}`} className="rounded-md p-1 text-luma-700 hover:bg-luma-100 disabled:cursor-not-allowed">
        <Plus className="size-4" />
      </button>
    </li>
  );
}

/** Component library: drag onto the canvas, or use the Add button (keyboard/touch alternative). */
export function Library({ check, onAdd }: { check: (t: BlockType) => AddCheck; onAdd: (t: BlockType) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">{t('builder.library.hint')}</p>
      {CATEGORIES.map((c) => {
        const types = BLOCK_TYPES.filter((x) => BLOCKS[x].category === c);
        if (!types.length) return null;
        return (
          <section key={c} aria-labelledby={`lib-${c}`}>
            <h3 id={`lib-${c}`} className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-luma-500">{t(`builder.library.cat.${c}`)}</h3>
            <ul className="flex flex-col gap-1.5">{types.map((x) => <Item key={x} type={x} check={check(x)} onAdd={onAdd} />)}</ul>
          </section>
        );
      })}
    </div>
  );
}
