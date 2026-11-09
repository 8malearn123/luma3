'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Eye, EyeOff, Images, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Field, FormErrorSummary, Input } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { PageHeader } from '../components/layout';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { ImagePicker } from '../builder/ImagePicker';
import type { CatalogRefs } from '../builder/types';

type Item = { id: string; before_asset_id: string | null; after_asset_id: string; caption_ar: string | null; caption_en: string | null; category: string | null; is_visible: boolean; sort: number };
type Asset = CatalogRefs['assets'][number];

/** Portfolio («أعمالي»): before/after pairs the storefront's before/after block can show. */
export function PortfolioPage() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const q = useApiQuery<Item[]>(['portfolio', access.slug], access.api('/portfolio'));
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const canEdit = access.can('builder.edit') && !access.readOnly;
  const toggle = useApiMutation<Item, unknown>((it) => api(access.api(`/portfolio/${it.id}`), { method: 'PATCH', body: { is_visible: !it.is_visible } }), { invalidate: [['portfolio', access.slug]] });
  const remove = useApiMutation<Item, unknown>((it) => api(access.api(`/portfolio/${it.id}`), { method: 'DELETE' }), { invalidate: [['portfolio', access.slug]], onSuccess: () => { setDeleting(null); toast({ tone: 'ok', text: t('expert.portfolio.deleted') }); } });

  return (
    <div>
      <PageHeader title={t('expert.portfolio.title')} subtitle={t('expert.portfolio.subtitle')}
        actions={canEdit ? <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t('expert.portfolio.add')}</Button> : null} />
      <p className="mb-4 text-sm text-ink-muted">{t('expert.portfolio.builder_hint')} <Link className="text-luma-700 underline" href={`/app/${access.slug}/builder`}>{t('nav.builder')}</Link></p>
      {toggle.error ? <p role="alert" className="mb-2 text-sm text-danger">{msg(toggle.error)}</p> : null}
      {q.isLoading ? <LoadingState rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={<Images className="size-8" aria-hidden />} title={t('expert.portfolio.empty')} hint={t('expert.portfolio.empty_hint')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.data.map((it) => (
            <li key={it.id} className="overflow-hidden rounded-2xl border border-line bg-white">
              <div className="grid grid-cols-2 gap-px bg-line">
                {it.before_asset_id ? (
                  <figure className="relative bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/v1/media/${it.before_asset_id}`} alt="" className="aspect-[4/5] w-full object-cover" />
                    <figcaption className="absolute top-1 start-1 rounded-full bg-black/60 px-2 text-xs text-white">{t('expert.ba.before')}</figcaption>
                  </figure>
                ) : <div className="flex items-center justify-center bg-luma-50 text-xs text-ink-muted">{t('expert.portfolio.single')}</div>}
                <figure className="relative bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/v1/media/${it.after_asset_id}`} alt="" className="aspect-[4/5] w-full object-cover" />
                  <figcaption className="absolute top-1 start-1 rounded-full bg-black/60 px-2 text-xs text-white">{t('expert.ba.after')}</figcaption>
                </figure>
              </div>
              <div className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{pick(it.caption_ar, it.caption_en) || t('expert.portfolio.untitled')}</p>
                  <div className="flex gap-1">{it.category ? <Badge>{it.category}</Badge> : null}{!it.is_visible ? <Badge tone="warn">{t('expert.portfolio.hidden')}</Badge> : null}</div>
                </div>
                {canEdit ? (
                  <>
                    <IconButton label={it.is_visible ? t('expert.portfolio.hide') : t('expert.portfolio.show')} onClick={() => toggle.mutate(it)}>{it.is_visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}</IconButton>
                    <IconButton label={t('builder.remove')} className="text-danger" onClick={() => setDeleting(it)}><Trash2 className="size-4" /></IconButton>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding ? <AddDrawer onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.refetch(); toast({ tone: 'ok', text: t('expert.portfolio.added') }); }} /> : null}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => remove.mutate(deleting!)} danger loading={remove.isPending}
        title={t('expert.portfolio.delete_title')} body={t('expert.portfolio.delete_body')} confirmLabel={t('builder.remove')} />
    </div>
  );
}

function AddDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [uploaded, setUploaded] = useState<Asset[]>([]);
  // The business's existing images (same list the builder offers).
  const lib = useApiQuery<{ catalog?: { assets?: Asset[] } }>(['builder-assets', access.slug], access.api('/builder'));
  const assets = [...uploaded, ...(lib.data?.catalog?.assets ?? []).filter((a) => !uploaded.some((u) => u.id === a.id))];
  const [f, setF] = useState({ before: null as string | null, after: null as string | null, caption_ar: '', caption_en: '', category: '' });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = useApiMutation<void, unknown>(() => api(access.api('/portfolio'), {
    body: { before_asset_id: f.before, after_asset_id: f.after, caption_ar: f.caption_ar || null, caption_en: f.caption_en || null, category: f.category || null },
  }), { onSuccess: onSaved });
  const onUploaded = (a: Asset) => setUploaded((xs) => [a, ...xs]);
  return (
    <Drawer open onClose={onClose} title={t('expert.portfolio.add')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button disabled={!f.after || f.before === f.after} loading={save.isPending} onClick={() => save.mutate()}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={save.error ? msg(save.error) : null} />
        <ImagePicker slug={access.slug} purpose="gallery" label={t('expert.ba.before_optional')} value={f.before} assets={assets} onUploaded={onUploaded} onChange={(id) => set({ before: id })} />
        <ImagePicker slug={access.slug} purpose="gallery" label={t('expert.ba.after')} value={f.after} assets={assets} onUploaded={onUploaded} onChange={(id) => set({ after: id })} />
        <Field label={t('expert.portfolio.caption_ar')}>{(p) => <Input {...p} maxLength={160} value={f.caption_ar} onChange={(e) => set({ caption_ar: e.target.value })} />}</Field>
        <Field label={t('expert.portfolio.caption_en')}>{(p) => <Input {...p} dir="ltr" maxLength={160} value={f.caption_en} onChange={(e) => set({ caption_en: e.target.value })} />}</Field>
        <Field label={t('expert.portfolio.category')} hint={t('expert.portfolio.category_hint')}>{(p) => <Input {...p} maxLength={40} value={f.category} onChange={(e) => set({ category: e.target.value })} />}</Field>
      </div>
    </Drawer>
  );
}
