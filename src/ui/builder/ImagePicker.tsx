'use client';

import { useRef, useState } from 'react';
import { ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Dialog } from '../components/overlay';
import { cx } from '../components/cx';
import type { CatalogRefs } from './types';

type Asset = CatalogRefs['assets'][number];

/**
 * Image picker: choose from the business's uploaded images or upload a new
 * one (the server decodes, re-encodes to WebP and strips metadata).
 */
export function ImagePicker({ slug, purpose, value, onChange, label, assets, onUploaded }: {
  slug: string; purpose: string; value: string | null | undefined; onChange: (id: string | null) => void; label: string; assets: Asset[]; onUploaded: (a: Asset) => void;
}) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    const fd = new FormData(); fd.set('file', file); fd.set('purpose', purpose);
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id: string; width: number; height: number }>(`/api/v1/t/${slug}/assets`, { form: fd });
      onUploaded({ id: r.id, purpose, width: r.width, height: r.height, alt_ar: null, alt_en: null, created_at: new Date().toISOString() });
      onChange(r.id); setOpen(false);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-3">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/v1/media/${value}`} alt="" className="size-16 rounded-lg border border-line object-cover" />
        ) : <div className="flex size-16 items-center justify-center rounded-lg border border-dashed border-luma-300 bg-luma-50"><ImagePlus className="size-5 text-luma-300" aria-hidden /></div>}
        <div className="flex flex-col gap-1">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{value ? t('builder.image.change') : t('builder.image.choose')}</Button>
          {value ? <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => onChange(null)}>{t('builder.image.remove')}</Button> : null}
        </div>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={label} footer={<Button variant="ghost" onClick={() => setOpen(false)}>{t('actions.close')}</Button>}>
        <div className="flex flex-col gap-3">
          <Button variant="primary" size="sm" icon={busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} disabled={busy} onClick={() => input.current?.click()}>{busy ? t('builder.image.uploading') : t('builder.image.upload')}</Button>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" className="sr-only" aria-label={t('builder.image.upload')}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          <p className="text-xs text-ink-muted">{t('builder.image.hint')}</p>
          {err ? <p className="text-xs text-danger" role="alert">{msg(err)}</p> : null}
          {assets.length ? (
            <ul className="grid max-h-72 grid-cols-4 gap-2 overflow-y-auto">
              {assets.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => { onChange(a.id); setOpen(false); }} aria-pressed={value === a.id}
                    className={cx('block w-full overflow-hidden rounded-lg border-2', value === a.id ? 'border-luma-700' : 'border-transparent hover:border-luma-300')}
                    aria-label={a.alt_ar || a.alt_en || t('builder.image.untitled')}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/v1/media/${a.id}`} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-muted">{t('builder.image.none')}</p>}
        </div>
      </Dialog>
    </div>
  );
}

/** Alt text of the asset itself (used where the block has no own alt field). */
export function AssetAltEditor({ slug, asset, onSaved }: { slug: string; asset: Asset | undefined; onSaved: (a: Asset) => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const [ar, setAr] = useState(asset?.alt_ar ?? '');
  const [en, setEn] = useState(asset?.alt_en ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  if (!asset) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-luma-50 p-2">
      <span className="text-xs font-medium">{t('builder.image.alt')}</span>
      <input aria-label={`${t('builder.image.alt')} (ع)`} dir="rtl" className="h-9 rounded-md border border-line px-2 text-sm" maxLength={160} value={ar} onChange={(e) => { setAr(e.target.value); setOk(false); }} />
      <input aria-label={`${t('builder.image.alt')} (EN)`} dir="ltr" className="h-9 rounded-md border border-line px-2 text-sm" maxLength={160} value={en} onChange={(e) => { setEn(e.target.value); setOk(false); }} />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" loading={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { await api(`/api/v1/t/${slug}/assets/${asset.id}`, { method: 'PATCH', body: { alt_ar: ar || null, alt_en: en || null } }); onSaved({ ...asset, alt_ar: ar || null, alt_en: en || null }); setOk(true); }
          catch (e) { setErr(e); } finally { setBusy(false); }
        }}>{t('builder.image.save_alt')}</Button>
        {ok ? <span className="text-xs text-ok">{t('builder.saved')}</span> : null}
        {err ? <span className="text-xs text-danger">{msg(err)}</span> : null}
      </div>
    </div>
  );
}
