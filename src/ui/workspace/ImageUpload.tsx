'use client';

import { useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';

/** Uploads an image to the tenant's asset store; the server validates and re-encodes it. */
export function ImageUpload({ slug, purpose, value, onChange, label }: { slug: string; purpose: string; value: string | null | undefined; onChange: (id: string | null) => void; label: string }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-3">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/v1/media/${value}`} alt="" className="size-20 rounded-lg border border-line object-cover" />
        ) : <div className="flex size-20 items-center justify-center rounded-lg border border-dashed border-luma-300 bg-luma-50"><ImagePlus className="size-6 text-luma-300" aria-hidden /></div>}
        <div className="flex flex-col gap-1">
          <Button variant="outline" size="sm" loading={busy} onClick={() => input.current?.click()}>{busy ? t('onboarding.uploading') : label}</Button>
          {value ? <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} onClick={() => onChange(null)}>{t('onboarding.remove')}</Button> : null}
        </div>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" className="sr-only" aria-label={label}
          onChange={async (e) => {
            const file = e.target.files?.[0]; if (!file) return;
            const fd = new FormData(); fd.set('file', file); fd.set('purpose', purpose);
            setBusy(true); setErr(null);
            try { const r = await api<{ id: string }>(`/api/v1/t/${slug}/assets`, { form: fd }); onChange(r.id); }
            catch (x) { setErr(x); } finally { setBusy(false); e.target.value = ''; }
          }} />
      </div>
      {err ? <p className="text-xs text-danger" role="alert">{msg(err)}</p> : null}
    </div>
  );
}
