'use client';

import { useRef } from 'react';
import { Crop, ImagePlus, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { useCropUpload } from '../business/CropEditor';

/**
 * Uploads an image to the tenant's asset store; the server validates and re-encodes it.
 * Logo, cover, service, product and staff images open the crop editor (crop/zoom/pan)
 * first; the stored asset is the cropped derivative.
 */
export function ImageUpload({ slug, purpose, value, onChange, label }: { slug: string; purpose: string; value: string | null | undefined; onChange: (id: string | null) => void; label: string }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const input = useRef<HTMLInputElement>(null);
  const crop = useCropUpload(slug, purpose, (r) => onChange(r.id));
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-3">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/v1/media/${value}`} alt="" className="size-20 rounded-lg border border-line object-cover" />
        ) : <div className="flex size-20 items-center justify-center rounded-lg border border-dashed border-luma-300 bg-luma-50"><ImagePlus className="size-6 text-luma-300" aria-hidden /></div>}
        <div className="flex flex-col gap-1">
          <Button variant="outline" size="sm" loading={crop.busy} onClick={() => input.current?.click()}>{crop.busy ? t('onboarding.uploading') : label}</Button>
          {value && crop.canCrop ? <Button variant="ghost" size="sm" icon={<Crop className="size-4" />} onClick={() => crop.recrop(value)}>{t('business.crop.edit')}</Button> : null}
          {value ? <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} onClick={() => onChange(null)}>{t('onboarding.remove')}</Button> : null}
        </div>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" className="sr-only" aria-label={label}
          onChange={(e) => { const file = e.target.files?.[0]; if (file) crop.pick(file); e.target.value = ''; }} />
      </div>
      {crop.error ? <p className="text-xs text-danger" role="alert">{msg(crop.error)}</p> : null}
      {crop.dialog}
    </div>
  );
}
