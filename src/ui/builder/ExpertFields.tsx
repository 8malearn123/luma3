'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Field, Input, LocalizedInput } from '../components/form';
import { Alert, Badge } from '../components/feedback';
import { ImagePicker } from './ImagePicker';
import type { CatalogRefs } from './types';

type L = { ar?: string; en?: string };
type Pair = { before_asset_id: string; after_asset_id: string; caption?: L; category?: L };
type Asset = CatalogRefs['assets'][number];

/** Before/after pairs editor (builder Properties panel). */
export function BeforeAfterItemsEditor({ slug, items, assets, onAssetsChange, onChange }: {
  slug: string; items: Pair[]; assets: Asset[]; onAssetsChange: (a: Asset) => void; onChange: (v: Pair[], coalesce?: boolean) => void;
}) {
  const { t } = useI18n();
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const move = (i: number, d: -1 | 1) => { const v = [...items]; [v[i + d], v[i]] = [v[i]!, v[i + d]!]; onChange(v); };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{t('expert.ba.pairs')} ({items.length}/30)</span>
      <ul className="flex flex-col gap-2">
        {items.map((it, i) => (
          <li key={`${it.before_asset_id}-${it.after_asset_id}-${i}`} className="flex flex-col gap-2 rounded-lg border border-line p-2">
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/v1/media/${it.before_asset_id}`} alt={t('expert.ba.before')} className="size-12 rounded object-cover" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/v1/media/${it.after_asset_id}`} alt={t('expert.ba.after')} className="size-12 rounded object-cover" />
              <span className="flex-1 text-xs text-ink-muted">#{i + 1}</span>
              <IconButton label={t('builder.canvas.move_up')} disabled={i === 0} className="size-7" onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></IconButton>
              <IconButton label={t('builder.canvas.move_down')} disabled={i === items.length - 1} className="size-7" onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></IconButton>
              <IconButton label={t('builder.remove')} className="size-7 text-danger" onClick={() => onChange(items.filter((_, k) => k !== i))}><Trash2 className="size-3.5" /></IconButton>
            </div>
            <LocalizedInput label={t('builder.f.caption')} value={it.caption} onChange={(v) => onChange(items.map((x, k) => (k === i ? { ...x, caption: v } : x)), true)} />
            <LocalizedInput label={t('builder.f.category')} value={it.category} onChange={(v) => onChange(items.map((x, k) => (k === i ? { ...x, category: v } : x)), true)} />
          </li>
        ))}
      </ul>
      {items.length < 30 ? (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-2">
          <legend className="px-1 text-xs font-medium">{t('expert.ba.add_pair')}</legend>
          <ImagePicker slug={slug} purpose="gallery" label={t('expert.ba.before')} value={before} assets={assets} onUploaded={onAssetsChange} onChange={setBefore} />
          <ImagePicker slug={slug} purpose="gallery" label={t('expert.ba.after')} value={after} assets={assets} onUploaded={onAssetsChange} onChange={setAfter} />
          <Button size="sm" variant="outline" disabled={!before || !after || before === after}
            onClick={() => { onChange([...items, { before_asset_id: before!, after_asset_id: after! }]); setBefore(null); setAfter(null); }}>{t('builder.add')}</Button>
        </fieldset>
      ) : null}
    </div>
  );
}

type IgSettings = { handle: string | null; effective_handle: string | null; status: string; provider_configured: boolean; last_synced_at: string | null; last_error: string | null; post_count: number };

/** Instagram account for the section: the handle, and the official connection when the platform supports it. */
export function InstagramConnectionField({ slug }: { slug: string }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const q = useApiQuery<IgSettings>(['instagram', slug], `/api/v1/t/${slug}/instagram`);
  const [handle, setHandle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const s = q.data;
  const value = handle ?? s?.handle ?? '';
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/v1/t/${slug}/instagram`, { method: 'PUT', body: { handle: value.trim() || null } }); setHandle(null); await q.refetch(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <legend className="px-1 text-sm font-medium">{t('expert.ig.account')}</legend>
      <Field label={t('expert.ig.handle')} hint={s && !s.handle && s.effective_handle ? t('expert.ig.from_social', { handle: s.effective_handle }) : t('expert.ig.handle_hint')}>{(p) => (
        <div className="flex gap-1">
          <Input {...p} dir="ltr" placeholder="@" value={value} maxLength={80} onChange={(e) => setHandle(e.target.value)} />
          <Button size="sm" variant="outline" loading={busy} onClick={save}>{t('actions.save')}</Button>
        </div>
      )}</Field>
      {s ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={s.status === 'connected' ? 'ok' : s.status === 'error' ? 'danger' : 'neutral'}>{t(`expert.ig.status.${s.status}`)}</Badge>
          {s.effective_handle ? <a className="inline-flex items-center gap-1 text-luma-700 underline" href={`https://www.instagram.com/${s.effective_handle}/`} target="_blank" rel="noreferrer">@{s.effective_handle}<ExternalLink className="size-3" aria-hidden /></a> : null}
        </div>
      ) : null}
      {s && !s.provider_configured ? <p className="text-xs text-ink-muted">{t('expert.ig.not_configured')}</p> : null}
      {s?.status === 'error' && s.last_error ? <Alert tone="warn">{t('expert.ig.sync_error')}</Alert> : null}
      {err ? <p role="alert" className="text-xs text-danger">{msg(err)}</p> : null}
    </fieldset>
  );
}
