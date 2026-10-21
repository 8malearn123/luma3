'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import {
  AlertTriangle, CheckCircle2, CloudOff, ExternalLink, History, LayoutTemplate, Loader2, Monitor, MousePointerClick, Palette, PanelsTopLeft, Plus,
  Redo2, Rocket, Smartphone, Sparkles, Undo2, FileText, LayoutList,
} from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Dialog } from '../components/overlay';
import { Select } from '../components/form';
import { useToast } from '../components/toast';
import { cx } from '../components/cx';
import { useAccess } from '../shell/access-context';
import { BLOCKS, type BlockType } from '@/shared/builder/blocks';
import { fontHref } from '../storefront/theme';
import { useBuilder, type BuilderApi } from './useBuilder';
import { Canvas } from './Canvas';
import { Library, BlockIcon } from './Library';
import { Properties } from './Properties';
import { BrandPanel } from './BrandPanel';
import { LayoutPanel } from './LayoutPanel';
import { PagesPanel } from './PagesPanel';
import { PublishDialog } from './PublishDialog';
import { VersionsDrawer } from './VersionsDrawer';
import { TemplatesDrawer } from './TemplatesDrawer';
import { AssistantPanel } from './AssistantPanel';
import { canAdd, duplicateBlock, findBlock, insertAt, moveBlock, newBlock, removeBlock, updateBlock } from './ops';
import type { BuilderPage, BuilderState, CatalogRefs } from './types';

type LeftTab = 'library' | 'pages' | 'brand' | 'layout' | 'assistant';

export function BuilderLoader({ slug }: { slug: string }) {
  const q = useApiQuery<BuilderState>(['builder', slug], `/api/v1/t/${slug}/builder`);
  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <BuilderApp slug={slug} initial={q.data} />;
}

function SaveIndicator({ b }: { b: BuilderApi }) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const time = b.lastSavedAt ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-SA', { hour: 'numeric', minute: '2-digit' }).format(b.lastSavedAt) : null;
  if (b.status === 'saving') return <span className="inline-flex items-center gap-1 text-xs text-ink-muted" role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden />{t('builder.save.saving')}</span>;
  if (b.status === 'error') return <span className="inline-flex items-center gap-1 text-xs text-danger" role="alert" title={msg(b.error)}><CloudOff className="size-3.5" aria-hidden />{t('builder.save.error')} <button className="underline" onClick={() => void b.retry()}>{t('actions.retry')}</button></span>;
  if (b.status === 'conflict') return <span className="inline-flex items-center gap-1 text-xs text-danger" role="alert"><AlertTriangle className="size-3.5" aria-hidden />{t('builder.save.conflict')}</span>;
  if (b.dirty.length) return <span className="text-xs text-warn" role="status">{t('builder.save.unsaved')}</span>;
  return <span className="inline-flex items-center gap-1 text-xs text-ink-muted" role="status"><CheckCircle2 className="size-3.5 text-ok" aria-hidden />{time ? t('builder.save.saved_at', { time }) : t('builder.save.all_saved')}</span>;
}

export function BuilderApp({ slug, initial }: { slug: string; initial: BuilderState }) {
  const { t, locale, pick } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const access = useAccess();
  const b = useBuilder(slug, initial);
  const server = b.server;
  const canPublish = access.can('builder.publish');
  const canEdit = access.can('builder.edit');
  const [pageId, setPageId] = useState(() => server.pages.find((p) => p.kind === 'home')?.id ?? server.pages[0]!.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [left, setLeft] = useState<LeftTab>('library');
  const [mobileTab, setMobileTab] = useState<'library' | 'canvas' | 'properties'>('canvas');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [drawer, setDrawer] = useState<'publish' | 'versions' | 'templates' | null>(null);
  const [extraAssets, setExtraAssets] = useState<CatalogRefs['assets']>([]);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [dragType, setDragType] = useState<BlockType | null>(null);

  const pages: BuilderPage[] = server.pages;
  const page = pages.find((p) => p.id === pageId) ?? pages[0]!;
  const blocks = useMemo(() => b.doc.blocks[page.id] ?? [], [b.doc.blocks, page.id]);
  const sel = selected ? findBlock(blocks, selected) : null;

  const refs: CatalogRefs = useMemo(() => {
    const byId = new Map([...server.catalog.assets, ...extraAssets].map((a) => [a.id, a]));
    return { ...server.catalog, assets: [...byId.values()] };
  }, [server.catalog, extraAssets]);
  const onAssetsChange = useCallback((a: CatalogRefs['assets'][number]) => setExtraAssets((xs) => [a, ...xs.filter((x) => x.id !== a.id)]), []);

  // Canvas data: live catalog from the server + the local (unsaved) draft.
  const data = useMemo(() => ({
    ...server.storefront,
    brand: b.doc.brand,
    layout: b.doc.layout,
    powered_by: !server.policy.can_remove_powered_by || b.doc.layout.footer.show_powered_by,
    pages: pages.filter((p) => p.status === 'active').map((p) => ({ id: p.id, kind: p.kind, slug: p.slug, title_ar: p.title_ar, title_en: p.title_en, show_in_nav: p.show_in_nav, show_in_footer: p.show_in_footer, sort: p.sort, blocks: b.doc.blocks[p.id] ?? [] })),
    assets: { ...server.storefront.assets, ...Object.fromEntries(refs.assets.map((a) => [a.id, { width: a.width, height: a.height, alt_ar: a.alt_ar, alt_en: a.alt_en }])) },
  }), [server, b.doc, pages, refs.assets]);

  useUnsavedChangesWarning(b.dirty.length > 0 || b.status === 'saving');
  // In-app navigation away with unsaved changes asks first.
  useEffect(() => {
    if (!b.dirty.length) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.closest('[data-builder-canvas]')) return;
      if (!window.confirm(t('states.unsaved_leave'))) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [b.dirty.length, t]);

  // Undo/redo shortcuts (native undo stays inside text fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input,textarea,select,[contenteditable="true"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) b.redo(); else b.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); b.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [b]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const check = useCallback((type: BlockType) => canAdd(type, blocks, refs, pages, server.policy.products), [blocks, refs, pages, server.policy.products]);
  const add = useCallback((type: BlockType, index?: number) => {
    if (!check(type).ok) return;
    const nb = newBlock(type, refs, pages);
    const selIdx = selected ? blocks.findIndex((x) => x.id === selected) : -1;
    const at = index ?? (selIdx >= 0 ? selIdx + 1 : blocks.length);
    b.setBlocks(page.id, (l) => insertAt(l, nb, at));
    setSelected(nb.id);
    setMobileTab('properties');
    toast({ tone: 'ok', text: t('builder.added', { name: BLOCKS[type].label[locale] }) });
  }, [b, blocks, check, locale, page.id, pages, refs, selected, t, toast]);

  const del = (id: string) => {
    const found = findBlock(blocks, id);
    b.setBlocks(page.id, (l) => removeBlock(l, id));
    if (selected === id) setSelected(null);
    toast({ tone: 'info', text: t('builder.deleted', { name: found ? BLOCKS[found.block.type].label[locale] : '' }), action: { label: t('builder.undo'), onClick: () => b.undo() } });
  };

  function onDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    setDragType(id.startsWith('lib:') ? (id.slice(4) as BlockType) : null);
  }
  function onDragEnd(e: DragEndEvent) {
    setDragType(null);
    const a = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!over) return;
    if (a.startsWith('lib:')) {
      const type = a.slice(4) as BlockType;
      const idx = over === 'canvas-end' ? blocks.length : blocks.findIndex((x) => x.id === over);
      add(type, idx < 0 ? blocks.length : idx);
      return;
    }
    if (a !== over && over !== 'canvas-end') {
      const from = blocks.findIndex((x) => x.id === a);
      const to = blocks.findIndex((x) => x.id === over);
      if (from >= 0 && to >= 0) b.setBlocks(page.id, (l) => arrayMove(l, from, to));
    }
  }

  async function openPreview() {
    setPreviewBusy(true);
    try {
      await b.flush();
      const r = await api<{ path: string }>(`/api/v1/t/${slug}/builder/preview-tokens`, { body: { ttl_hours: 24 } });
      const pg = page.kind === 'home' ? '' : `?page=${encodeURIComponent(page.slug)}`;
      window.open(`${r.path}${pg}`, '_blank', 'noopener');
    } catch (e) { toast({ tone: 'danger', text: msg(e) }); } finally { setPreviewBusy(false); }
  }

  const prepare = async () => {
    const ok = await b.flush();
    if (!ok) { toast({ tone: 'danger', text: t('builder.save.before_publish') }); return null; }
    return b.refreshServer();
  };

  const leftTabs: Array<{ key: LeftTab; icon: typeof Plus; label: string }> = [
    { key: 'library', icon: Plus, label: t('builder.tabs.library') },
    { key: 'pages', icon: FileText, label: t('builder.tabs.pages') },
    { key: 'brand', icon: Palette, label: t('builder.tabs.brand') },
    { key: 'layout', icon: PanelsTopLeft, label: t('builder.tabs.layout') },
    { key: 'assistant', icon: Sparkles, label: t('builder.tabs.assistant') },
  ];

  const leftPanel = (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label={t('builder.tabs.label')} className="grid grid-cols-5 gap-1 rounded-lg bg-luma-100 p-1">
        {leftTabs.map((x) => (
          <button key={x.key} role="tab" type="button" aria-selected={left === x.key} onClick={() => setLeft(x.key)} title={x.label}
            className={cx('flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[11px]', left === x.key ? 'bg-white font-semibold text-luma-800 shadow-sm' : 'text-ink-muted hover:text-ink')}>
            <x.icon className="size-4" aria-hidden /><span className="truncate">{x.label}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {left === 'library' ? <Library check={check} onAdd={(ty) => add(ty)} /> : null}
        {left === 'pages' ? (
          <PagesPanel slug={slug} pages={pages} current={page.id} limit={server.policy.custom_pages_limit}
            onSelect={(id) => { setPageId(id); setSelected(null); }}
            onChanged={() => { void b.refreshServer(); }}
            onCreated={(p) => { b.addPage(p); b.setServer((s) => ({ ...s, pages: [...s.pages, p] })); setPageId(p.id); setSelected(null); void b.refreshServer(); }} />
        ) : null}
        {left === 'brand' ? <BrandPanel slug={slug} brand={b.doc.brand} assets={refs.assets} onAssetsChange={onAssetsChange} onChange={(fn, key) => b.commit((d) => ({ ...d, brand: fn(d.brand) }), key)} /> : null}
        {left === 'layout' ? <LayoutPanel layout={b.doc.layout} canRemovePoweredBy={server.policy.can_remove_powered_by} productsEnabled={server.policy.products} onChange={(fn) => b.commit((d) => ({ ...d, layout: fn(d.layout) }))} /> : null}
        {left === 'assistant' ? <AssistantPanel slug={slug} status={server.ai_status} pages={pages} beforePropose={b.flush} onApplied={() => { void b.reload(); }} /> : null}
      </div>
    </div>
  );

  const propsPanel = sel ? (
    <Properties key={sel.block.id} slug={slug} block={sel.block} parent={sel.parent} pageBlocks={blocks} refs={refs} pages={pages} warnings={b.warnings}
      onSelect={setSelected} onAssetsChange={onAssetsChange}
      onChange={(fn, key) => b.setBlocks(page.id, (l) => updateBlock(l, sel.block.id, fn), key)} />
  ) : (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-luma-200 p-6 text-center text-sm text-ink-muted">
      <MousePointerClick className="size-6 text-luma-300" aria-hidden />
      <p>{t('builder.select_hint')}</p>
      {blocks.length ? (
        <ul className="mt-2 flex w-full flex-col gap-1 text-start">
          {blocks.map((x) => (
            <li key={x.id}><button type="button" onClick={() => setSelected(x.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-luma-100">
              <BlockIcon name={BLOCKS[x.type].icon} className="size-4 text-luma-700" /><span className="flex-1 truncate">{BLOCKS[x.type].label[locale]}</span>
              {!x.visibility.enabled ? <Badge>{t('builder.canvas.hidden_badge')}</Badge> : null}
            </button></li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <link rel="stylesheet" href={fontHref(b.doc.brand)} precedence="default" />
      {/* Toolbar */}
      <div className="sticky top-14 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white/95 p-2 shadow-sm backdrop-blur">
        <label className="sr-only" htmlFor="builder-page">{t('builder.page')}</label>
        <Select id="builder-page" className="!h-9 w-auto min-w-36" value={page.id} onChange={(e) => { setPageId(e.target.value); setSelected(null); }}>
          {pages.filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{pick(p.title_ar, p.title_en)}</option>)}
        </Select>
        <IconButton label={`${t('builder.undo')} (Ctrl+Z)`} disabled={!b.canUndo} onClick={b.undo}><Undo2 className="size-4 flip-rtl" /></IconButton>
        <IconButton label={`${t('builder.redo')} (Ctrl+Shift+Z)`} disabled={!b.canRedo} onClick={b.redo}><Redo2 className="size-4 flip-rtl" /></IconButton>
        <SaveIndicator b={b} />
        <div className="flex-1" />
        <div role="group" aria-label={t('builder.device')} className="flex rounded-lg bg-luma-100 p-0.5">
          <button type="button" aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')} className={cx('rounded-md p-1.5', device === 'desktop' && 'bg-white shadow-sm')} title={t('builder.desktop')} aria-label={t('builder.desktop')}><Monitor className="size-4" /></button>
          <button type="button" aria-pressed={device === 'mobile'} onClick={() => setDevice('mobile')} className={cx('rounded-md p-1.5', device === 'mobile' && 'bg-white shadow-sm')} title={t('builder.mobile')} aria-label={t('builder.mobile')}><Smartphone className="size-4" /></button>
        </div>
        <Button size="sm" variant="ghost" icon={<ExternalLink className="size-4" />} loading={previewBusy} onClick={openPreview}>{t('builder.preview')}</Button>
        <Button size="sm" variant="ghost" icon={<LayoutTemplate className="size-4" />} onClick={() => setDrawer('templates')} className="hidden sm:inline-flex">{t('builder.templates.title')}</Button>
        <Button size="sm" variant="ghost" icon={<History className="size-4" />} onClick={() => setDrawer('versions')}>{t('builder.versions.title')}</Button>
        <Button size="sm" icon={<Rocket className="size-4" />} onClick={() => setDrawer('publish')}>{t('builder.publish.button')}</Button>
      </div>
      {!canEdit ? <Alert tone="info">{t('builder.read_only')}</Alert> : null}
      {server.published.version_number ? (
        <p className="text-xs text-ink-muted">{t('builder.live_version', { n: server.published.version_number })} · <a className="text-luma-700 underline" href={`/s/${slug}`} target="_blank" rel="noreferrer">{t('builder.open_live')}</a></p>
      ) : <p className="text-xs text-ink-muted">{t('builder.not_published')}</p>}

      {/* Mobile tabs */}
      <div role="tablist" aria-label={t('builder.areas')} className="grid grid-cols-3 gap-1 rounded-lg bg-luma-100 p-1 lg:hidden">
        {(['library', 'canvas', 'properties'] as const).map((k) => (
          <button key={k} role="tab" type="button" aria-selected={mobileTab === k} onClick={() => setMobileTab(k)}
            className={cx('flex items-center justify-center gap-1 rounded-md py-1.5 text-sm', mobileTab === k ? 'bg-white font-semibold shadow-sm' : 'text-ink-muted')}>
            {k === 'library' ? <Plus className="size-4" aria-hidden /> : k === 'canvas' ? <LayoutList className="size-4" aria-hidden /> : <MousePointerClick className="size-4" aria-hidden />}{t(`builder.areas_${k}`)}
          </button>
        ))}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragType(null)}
        accessibility={{ screenReaderInstructions: { draggable: t('builder.canvas.instructions') } }}>
        <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
          <aside aria-label={t('builder.areas_library')} className={cx('max-h-[calc(100dvh-10rem)] overflow-y-auto rounded-xl border border-line bg-white/70 p-3 lg:sticky lg:top-32 lg:block', mobileTab === 'library' ? 'block' : 'hidden')}>
            {leftPanel}
          </aside>
          <div data-builder-canvas className={cx('min-w-0 lg:block', mobileTab === 'canvas' ? 'block' : 'hidden')}>
            <Canvas data={data} page={data.pages.find((p) => p.id === page.id) ?? { ...page, blocks }} blocks={blocks} device={device} selected={selected} warnings={b.warnings.filter((w) => w.pageId === page.id)}
              onSelect={setSelected}
              onMove={(id, d) => b.setBlocks(page.id, (l) => moveBlock(l, id, d))}
              onDuplicate={(id) => { const r = duplicateBlock(blocks, id); b.setBlocks(page.id, () => r.list); if (r.newId) setSelected(r.newId); }}
              onToggle={(id) => b.setBlocks(page.id, (l) => updateBlock(l, id, (x) => ({ ...x, visibility: { ...x.visibility, enabled: !x.visibility.enabled } })))}
              onDelete={del}
              onAddAt={() => { setLeft('library'); setMobileTab('library'); }} />
          </div>
          <aside aria-label={t('builder.areas_properties')} className={cx('max-h-[calc(100dvh-10rem)] overflow-y-auto rounded-xl border border-line bg-white p-3 lg:sticky lg:top-32 lg:block', mobileTab === 'properties' ? 'block' : 'hidden')}>
            {propsPanel}
          </aside>
        </div>
        <DragOverlay>{dragType ? <div className="flex items-center gap-2 rounded-lg border border-luma-300 bg-white px-3 py-2 text-sm shadow-lg"><BlockIcon name={BLOCKS[dragType].icon} className="size-4" />{BLOCKS[dragType].label[locale]}</div> : null}</DragOverlay>
      </DndContext>

      <Dialog open={!!b.conflict} onClose={() => {}} title={t('builder.conflict.title')} footer={<>
        <Button variant="outline" onClick={() => { void b.reload(); }}>{t('builder.conflict.reload')}</Button>
        <Button onClick={() => { void b.keepMine(); }}>{t('builder.conflict.keep')}</Button>
      </>}>
        <p>{t('builder.conflict.body')}</p>
      </Dialog>

      {drawer === 'publish' ? <PublishDialog open onClose={() => setDrawer(null)} slug={slug} canPublish={canPublish} prepare={prepare}
        onPublished={(r) => { toast({ tone: 'ok', text: r.first_publish ? t('builder.publish.first_done') : t('builder.publish.done', { n: r.version_number }) }); void b.refreshServer(); }} /> : null}
      <VersionsDrawer open={drawer === 'versions'} onClose={() => setDrawer(null)} slug={slug} canPublish={canPublish} beforeRestore={b.flush}
        onRestored={() => { void b.reload(); }} onRolledBack={() => { void b.refreshServer(); }} />
      <TemplatesDrawer open={drawer === 'templates'} onClose={() => setDrawer(null)} slug={slug} beforeApply={b.flush} onApplied={() => { void b.reload(); toast({ tone: 'ok', text: t('builder.templates.applied') }); }} />
    </div>
  );
}

