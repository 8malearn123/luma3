'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { Field, Input, Select } from '../components/form';
import { cx } from '../components/cx';
import { COLOR_TOKENS, contrastWarnings, FONTS, type Brand, type ColorToken, type FontKey } from '@/shared/builder/theme';
import { ImagePicker } from './ImagePicker';
import type { CatalogRefs } from './types';

function ColorField({ token, value, onChange }: { token: ColorToken; value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) { setPrev(value); setText(value); }
  const id = `color-${token}`;
  return (
    <div className="flex items-center gap-2">
      <input type="color" aria-label={t(`builder.brand.colors.${token}`)} value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-9 w-10 shrink-0 cursor-pointer rounded border border-line bg-white" />
      <label htmlFor={id} className="flex-1 text-sm">{t(`builder.brand.colors.${token}`)}</label>
      <input id={id} dir="ltr" value={text} maxLength={7} onChange={(e) => { const v = e.target.value; setText(v); if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toUpperCase()); }}
        aria-invalid={!/^#[0-9a-fA-F]{6}$/.test(text)} className="h-9 w-24 rounded-md border border-line px-2 font-mono text-xs aria-[invalid=true]:border-danger" />
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(o)}
            className={cx('rounded-md border px-2.5 py-1 text-xs', value === o ? 'border-luma-700 bg-luma-700 text-white' : 'border-line bg-white hover:border-luma-300')}>{t(`builder.o.${o}`)}</button>
        ))}
      </div>
    </div>
  );
}

/** Theme tokens (single source of truth: brand_settings). Contrast problems are warned about, never silently "fixed". */
export function BrandPanel({ slug, brand, onChange, assets, onAssetsChange }: { slug: string; brand: Brand; onChange: (fn: (b: Brand) => Brand, key?: string) => void; assets: CatalogRefs['assets']; onAssetsChange: (a: CatalogRefs['assets'][number]) => void }) {
  const { t } = useI18n();
  const warnings = contrastWarnings(brand.colors);
  const fontOpts = Object.entries(FONTS) as Array<[FontKey, (typeof FONTS)[FontKey]]>;
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('builder.brand.colors_title')}</h3>
        {COLOR_TOKENS.map((tk) => <ColorField key={tk} token={tk} value={brand.colors[tk]} onChange={(v) => onChange((b) => ({ ...b, colors: { ...b.colors, [tk]: v } }), `color.${tk}`)} />)}
        {warnings.length ? (
          <div role="status" className="flex flex-col gap-1 rounded-lg border border-warn/30 bg-warn-bg p-2 text-xs text-warn">
            {warnings.map((w) => (
              <p key={w.pair.join()} className="flex gap-1"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t('builder.brand.contrast', { a: t(`builder.brand.colors.${w.pair[0]}`), b: t(`builder.brand.colors.${w.pair[1]}`), ratio: w.ratio, min: w.min })}</p>
            ))}
          </div>
        ) : <p className="text-xs text-ok">{t('builder.brand.contrast_ok')}</p>}
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t('builder.brand.fonts_title')}</h3>
        {(['heading', 'body'] as const).map((slot) => (
          <Field key={slot} label={t(`builder.brand.font_${slot}`)}>{(p) => (
            <Select {...p} value={brand.fonts[slot]} onChange={(e) => onChange((b) => ({ ...b, fonts: { ...b.fonts, [slot]: e.target.value as FontKey } }))}>
              {fontOpts.map(([k, f]) => <option key={k} value={k}>{f.family}</option>)}
            </Select>
          )}</Field>
        ))}
        <p className="rounded-lg border border-line bg-white p-3 text-lg" style={{ fontFamily: FONTS[brand.fonts.heading].css }}>{t('builder.brand.sample')}</p>
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t('builder.brand.shape_title')}</h3>
        <Segmented label={t('builder.brand.radius')} value={brand.radius} options={['none', 'sm', 'md', 'lg', 'pill'] as const} onChange={(v) => onChange((b) => ({ ...b, radius: v }))} />
        <Segmented label={t('builder.brand.button_style')} value={brand.button_style} options={['solid', 'outline', 'soft'] as const} onChange={(v) => onChange((b) => ({ ...b, button_style: v }))} />
        <Segmented label={t('builder.brand.card_style')} value={brand.card_style} options={['flat', 'bordered', 'elevated'] as const} onChange={(v) => onChange((b) => ({ ...b, card_style: v }))} />
        <Segmented label={t('builder.brand.density')} value={brand.density} options={['compact', 'comfortable', 'spacious'] as const} onChange={(v) => onChange((b) => ({ ...b, density: v }))} />
        <Field label={`${t('builder.brand.spacing')}: ${brand.spacing_scale}`}>{(p) => (
          <input {...p} type="range" min={0.75} max={1.5} step={0.05} value={brand.spacing_scale} onChange={(e) => onChange((b) => ({ ...b, spacing_scale: Number(e.target.value) }), 'spacing')} className="accent-luma-700" />
        )}</Field>
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t('builder.brand.identity_title')}</h3>
        <ImagePicker slug={slug} purpose="logo" label={t('builder.brand.logo')} value={brand.logo_asset_id} assets={assets} onUploaded={onAssetsChange} onChange={(id) => onChange((b) => ({ ...b, logo_asset_id: id }))} />
        <Field label={t('builder.brand.wordmark')}>{(p) => <Input {...p} maxLength={60} value={brand.wordmark_text ?? ''} onChange={(e) => onChange((b) => ({ ...b, wordmark_text: e.target.value || null }), 'wordmark')} />}</Field>
        <Field label={t('builder.brand.tagline_ar')}>{(p) => <Input {...p} dir="rtl" maxLength={140} value={brand.tagline_ar ?? ''} onChange={(e) => onChange((b) => ({ ...b, tagline_ar: e.target.value || null }), 'tagline_ar')} />}</Field>
        <Field label={t('builder.brand.tagline_en')}>{(p) => <Input {...p} dir="ltr" maxLength={140} value={brand.tagline_en ?? ''} onChange={(e) => onChange((b) => ({ ...b, tagline_en: e.target.value || null }), 'tagline_en')} />}</Field>
      </section>
    </div>
  );
}
