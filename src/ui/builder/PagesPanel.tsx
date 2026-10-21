'use client';

import { useState } from 'react';
import { Archive, ArchiveRestore, FileText, Plus } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Checkbox, Field, FormErrorSummary, Input } from '../components/form';
import { Badge } from '../components/feedback';
import { ConfirmDialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { cx } from '../components/cx';
import type { BuilderPage } from './types';

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function PageMeta({ slug, page, onSaved }: { slug: string; page: BuilderPage; onSaved: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const [f, setF] = useState({ title_ar: page.title_ar ?? '', title_en: page.title_en ?? '', slug: page.slug, show_in_nav: page.show_in_nav, show_in_footer: page.show_in_footer });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const dirty = f.title_ar !== (page.title_ar ?? '') || f.title_en !== (page.title_en ?? '') || f.slug !== page.slug || f.show_in_nav !== page.show_in_nav || f.show_in_footer !== page.show_in_footer;
  const custom = page.kind === 'custom';
  const patch = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try { await api(`/api/v1/t/${slug}/builder/pages/${page.id}`, { method: 'PATCH', body }); toast({ tone: 'ok', text: t('builder.pages.saved') }); onSaved(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-white p-3">
      <FormErrorSummary message={err ? msg(err) : null} />
      <Field label={t('builder.pages.title_ar')}>{(p) => <Input {...p} dir="rtl" maxLength={120} value={f.title_ar} onChange={(e) => setF({ ...f, title_ar: e.target.value })} />}</Field>
      <Field label={t('builder.pages.title_en')}>{(p) => <Input {...p} dir="ltr" maxLength={120} value={f.title_en} onChange={(e) => setF({ ...f, title_en: e.target.value })} />}</Field>
      <Field label={t('builder.pages.slug')} hint={custom ? `/s/${slug}/pages/${f.slug}` : t('builder.pages.slug_fixed')}>{(p) => (
        <Input {...p} dir="ltr" disabled={!custom} maxLength={60} value={f.slug} onChange={(e) => setF({ ...f, slug: slugify(e.target.value) })} />
      )}</Field>
      <Checkbox label={t('builder.pages.in_nav')} checked={f.show_in_nav} onChange={(v) => setF({ ...f, show_in_nav: v })} />
      <Checkbox label={t('builder.pages.in_footer')} checked={f.show_in_footer} onChange={(v) => setF({ ...f, show_in_footer: v })} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!dirty || (!f.title_ar && !f.title_en)} loading={busy}
          onClick={() => patch({ title_ar: f.title_ar || null, title_en: f.title_en || null, show_in_nav: f.show_in_nav, show_in_footer: f.show_in_footer, ...(custom && f.slug !== page.slug ? { slug: f.slug } : {}) })}>{t('actions.save')}</Button>
        {custom ? <Button size="sm" variant="ghost" icon={<Archive className="size-4" />} onClick={() => setConfirm(true)}>{t('builder.pages.archive')}</Button> : null}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={t('builder.pages.archive_confirm')} body={t('builder.pages.archive_body')} loading={busy}
        onConfirm={async () => {
          setBusy(true);
          try { await api(`/api/v1/t/${slug}/builder/pages/${page.id}`, { method: 'DELETE' }); setConfirm(false); onSaved(); }
          catch (e) { setErr(e); setConfirm(false); } finally { setBusy(false); }
        }} />
    </div>
  );
}

/** Pages: switch page, add custom pages (plan limit), rename, address, nav/footer links, archive/restore. */
export function PagesPanel({ slug, pages, current, onSelect, onChanged, onCreated, limit }: {
  slug: string; pages: BuilderPage[]; current: string; onSelect: (id: string) => void; onChanged: () => void;
  onCreated: (p: BuilderPage) => void; limit: number | null;
}) {
  const { t, pick } = useI18n();
  const msg = useErrorMessage();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title_ar: '', title_en: '', slug: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const active = pages.filter((p) => p.status === 'active');
  const archived = pages.filter((p) => p.status === 'archived');
  const customCount = active.filter((p) => p.kind === 'custom').length;
  const atLimit = limit !== null && customCount >= limit;

  async function create() {
    setBusy(true); setErr(null);
    try {
      const r = await api<BuilderPage>(`/api/v1/t/${slug}/builder/pages`, { body: { title_ar: form.title_ar || null, title_en: form.title_en || null, slug: form.slug || slugify(form.title_en) || `page-${customCount + 1}`, show_in_footer: true } });
      onCreated({ ...r, status: 'active', updated_at: new Date().toISOString() });
      setAdding(false); setForm({ title_ar: '', title_en: '', slug: '' });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1">
        {active.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onSelect(p.id)} aria-current={p.id === current ? 'page' : undefined}
              className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-sm', p.id === current ? 'bg-luma-700 text-white' : 'hover:bg-luma-100')}>
              <FileText className="size-4 shrink-0" aria-hidden />
              <span className="flex-1 truncate">{pick(p.title_ar, p.title_en)}</span>
              {p.show_in_nav ? <Badge tone={p.id === current ? 'brand' : 'neutral'}>{t('builder.pages.nav_badge')}</Badge> : null}
            </button>
          </li>
        ))}
      </ul>
      {pages.find((p) => p.id === current && p.status === 'active') ? <PageMeta key={current} slug={slug} page={pages.find((p) => p.id === current)!} onSaved={onChanged} /> : null}

      <div className="flex flex-col gap-2">
        <p className="text-xs text-ink-muted">{limit === null ? t('builder.pages.unlimited', { n: customCount }) : t('builder.pages.limit', { n: customCount, max: limit })}</p>
        {adding ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-white p-3">
            <FormErrorSummary message={err ? msg(err) : null} />
            <Field label={t('builder.pages.title_ar')}>{(p) => <Input {...p} dir="rtl" maxLength={120} value={form.title_ar} onChange={(e) => setForm({ ...form, title_ar: e.target.value })} />}</Field>
            <Field label={t('builder.pages.title_en')}>{(p) => <Input {...p} dir="ltr" maxLength={120} value={form.title_en} onChange={(e) => setForm({ ...form, title_en: e.target.value, slug: form.slug || '' })} />}</Field>
            <Field label={t('builder.pages.slug')} hint={`/s/${slug}/pages/${form.slug || slugify(form.title_en) || '…'}`}>{(p) => <Input {...p} dir="ltr" maxLength={60} value={form.slug} onChange={(e) => setForm({ ...form, slug: slugify(e.target.value) })} />}</Field>
            <div className="flex gap-2">
              <Button size="sm" loading={busy} disabled={!form.title_ar && !form.title_en} onClick={create}>{t('builder.pages.create')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('actions.cancel')}</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" icon={<Plus className="size-4" />} disabled={atLimit} onClick={() => setAdding(true)} title={atLimit ? t('errors.plan_limit_reached') : undefined}>{t('builder.pages.add')}</Button>
        )}
        {atLimit ? <p className="text-xs text-warn">{t('builder.pages.limit_reached')}</p> : null}
      </div>

      {archived.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-muted">{t('builder.pages.archived', { n: archived.length })}</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {archived.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-md bg-luma-50 px-2 py-1">
                <span className="flex-1 truncate">{pick(p.title_ar, p.title_en)}</span>
                <Button size="sm" variant="ghost" icon={<ArchiveRestore className="size-4" />} disabled={atLimit}
                  onClick={async () => { try { await api(`/api/v1/t/${slug}/builder/pages/${p.id}`, { method: 'PATCH', body: { restore: true } }); onChanged(); } catch (e) { setErr(e); } }}>{t('builder.pages.restore')}</Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
