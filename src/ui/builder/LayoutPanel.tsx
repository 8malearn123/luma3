'use client';

import { Lock } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { Field, Select, Switch } from '../components/form';
import type { SiteLayout } from '@/shared/builder/blocks';

/** Navigation, header/footer and display options (site_drafts.layout). */
export function LayoutPanel({ layout, onChange, canRemovePoweredBy, productsEnabled }: { layout: SiteLayout; onChange: (fn: (l: SiteLayout) => SiteLayout) => void; canRemovePoweredBy: boolean; productsEnabled: boolean }) {
  const { t } = useI18n();
  const sel = <K extends 'nav_style' | 'booking_entry' | 'service_display' | 'product_display'>(key: K, options: readonly string[]) => (
    <Field label={t(`builder.layout.${key}`)}>{(p) => (
      <Select {...p} value={layout[key]} onChange={(e) => onChange((l) => ({ ...l, [key]: e.target.value }))}>
        {options.map((o) => <option key={o} value={o}>{t(`builder.o.${key === 'nav_style' && o === 'bottom' ? 'bottom_nav' : o}`)}</option>)}
      </Select>
    )}</Field>
  );
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t('builder.layout.navigation')}</h3>
        {sel('nav_style', ['simple', 'pill', 'bottom'])}
        {sel('booking_entry', ['both', 'header', 'floating'])}
        <p className="text-xs text-ink-muted">{t('builder.layout.booking_always')}</p>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('builder.layout.header')}</h3>
        {(['show_logo', 'show_name', 'sticky', 'show_book_button'] as const).map((k) => (
          <Switch key={k} label={t(`builder.layout.h.${k}`)} checked={layout.header[k]} onChange={(v) => onChange((l) => ({ ...l, header: { ...l.header, [k]: v } }))} />
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('builder.layout.footer')}</h3>
        {(['show_social', 'show_hours', 'show_policies'] as const).map((k) => (
          <Switch key={k} label={t(`builder.layout.f.${k}`)} checked={layout.footer[k]} onChange={(v) => onChange((l) => ({ ...l, footer: { ...l.footer, [k]: v } }))} />
        ))}
        <Switch label={t('builder.layout.f.show_powered_by')} checked={layout.footer.show_powered_by || !canRemovePoweredBy} disabled={!canRemovePoweredBy}
          onChange={(v) => onChange((l) => ({ ...l, footer: { ...l.footer, show_powered_by: v } }))} />
        {!canRemovePoweredBy ? <p className="flex items-center gap-1 text-xs text-ink-muted"><Lock className="size-3.5" aria-hidden />{t('builder.layout.powered_by_locked')}</p> : null}
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t('builder.layout.display')}</h3>
        {sel('service_display', ['cards', 'list'])}
        {productsEnabled ? sel('product_display', ['grid', 'list']) : null}
      </section>
    </div>
  );
}
