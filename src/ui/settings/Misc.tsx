'use client';

import Link from 'next/link';
import { CreditCard, ExternalLink } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatClock } from '@/shared/format';
import { Alert } from '../components/feedback';
import { Checkbox, Field, Input } from '../components/form';
import { Card } from '../components/layout';
import { cx } from '../components/cx';
import { ChannelBadge, SaveBar, SectionErrors, intOf, useSection, type SettingsData } from './shared';

export function NotificationsSection({ slug, data }: { slug: string; data: SettingsData }) {
  const { t } = useI18n();
  const s = useSection(slug, data, (d) => ({ channels: d.settings.notify_channels as string[] }));
  const toggle = (c: string, on: boolean) => s.set({ channels: on ? [...new Set([...s.values.channels, c])] : s.values.channels.filter((x) => x !== c) });
  return (
    <Card title={t('biz_settings.notify.title')}>
      <div className="flex flex-col gap-3">
        <SectionErrors err={s.err} onReload={s.reload} />
        <p className="text-sm text-ink-muted">{t('biz_settings.notify.hint')}</p>
        <ul className="flex flex-col gap-2">
          {(['in_app', 'email', 'sms', 'whatsapp'] as const).map((c) => (
            <li key={c} className="flex items-center justify-between gap-2 rounded-lg border border-line p-3">
              <Checkbox label={t(`platform.channels.${c}`)} checked={c === 'in_app' || s.values.channels.includes(c)} disabled={c === 'in_app'} onChange={(v) => toggle(c, v)}
                description={c === 'in_app' ? t('biz_settings.notify.in_app_always') : undefined} />
              <ChannelBadge state={data.channel_status[c]} />
            </li>
          ))}
        </ul>
        {(['email', 'sms', 'whatsapp'] as const).some((c) => s.values.channels.includes(c) && data.channel_status[c] !== 'connected') ? <Alert tone="warn">{t('biz_settings.notify.not_connected')}</Alert> : null}
        <SaveBar dirty={s.dirty} busy={s.busy} onSave={() => s.save('notifications', { notify_channels: s.values.channels })} />
      </div>
    </Card>
  );
}

export function DisplaySection({ slug, data }: { slug: string; data: SettingsData }) {
  const { t, locale } = useI18n();
  const s = useSection(slug, data, (d) => ({ time_format: d.settings.time_format as '12h' | '24h' }));
  return (
    <Card title={t('biz_settings.display.title')}>
      <div className="flex flex-col gap-3">
        <SectionErrors err={s.err} onReload={s.reload} />
        <fieldset className="flex flex-wrap gap-2">
          <legend className="mb-1 text-sm font-medium">{t('biz_settings.display.time_format')}</legend>
          {(['12h', '24h'] as const).map((f) => (
            <label key={f} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm', s.values.time_format === f ? 'border-luma-500 bg-luma-50' : 'border-line')}>
              <input type="radio" name="time_format" className="accent-luma-700" checked={s.values.time_format === f} onChange={() => s.set({ time_format: f })} />
              {t(f === '12h' ? 'time.h12' : 'time.h24')} <span className="text-ink-muted" dir="ltr">({formatClock('18:30', locale, f)})</span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-ink-muted">{t('biz_settings.display.hint')}</p>
        <SaveBar dirty={s.dirty} busy={s.busy} onSave={() => s.save('display', { time_format: s.values.time_format })} />
      </div>
    </Card>
  );
}

export function LegalTaxSection({ slug, data }: { slug: string; data: SettingsData }) {
  const { t } = useI18n();
  const s = useSection(slug, data, (d) => ({
    legal_name: d.settings.legal_name ?? '', tax_number: d.settings.tax_number ?? '', legal_address: d.settings.legal_address ?? '',
    tax_rate_bp: d.settings.tax_rate_bp as number, prices_include_tax: d.settings.prices_include_tax as boolean, tax_label: d.settings.tax_label ?? '',
  }));
  const v = s.values;
  return (
    <Card title={t('biz_settings.legal.title')}>
      <div className="flex flex-col gap-4">
        <Alert tone="warn">{t('biz_settings.legal.no_compliance')}</Alert>
        <SectionErrors err={s.err} onReload={s.reload} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('biz_settings.legal.legal_name')}>{(p) => <Input {...p} value={v.legal_name} maxLength={200} onChange={(e) => s.set({ legal_name: e.target.value })} />}</Field>
          <Field label={t('biz_settings.legal.tax_number')}>{(p) => <Input {...p} dir="ltr" value={v.tax_number} maxLength={30} onChange={(e) => s.set({ tax_number: e.target.value })} />}</Field>
          <Field label={t('biz_settings.legal.address')} className="sm:col-span-2">{(p) => <Input {...p} value={v.legal_address} maxLength={400} onChange={(e) => s.set({ legal_address: e.target.value })} />}</Field>
        </div>
        <h3 className="text-sm font-semibold">{t('biz_settings.legal.tax_rules')}</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('biz_settings.legal.tax_rate')} hint={t('biz_settings.legal.tax_rate_hint')}>{(p) => (
            <div className="flex items-center gap-2"><Input {...p} type="number" min={0} max={100} step="0.01" dir="ltr" value={v.tax_rate_bp / 100} onChange={(e) => s.set({ tax_rate_bp: Math.min(10000, Math.round(Number(e.target.value || 0) * 100)) })} />
              <span className="shrink-0 text-xs text-ink-muted">%</span></div>
          )}</Field>
          <Field label={t('biz_settings.legal.tax_label')} hint={t('biz_settings.legal.tax_label_hint')}>{(p) => <Input {...p} value={v.tax_label} maxLength={40} onChange={(e) => s.set({ tax_label: e.target.value })} />}</Field>
          <div className="self-end pb-2"><Checkbox label={t('biz_settings.legal.prices_include_tax')} checked={v.prices_include_tax} onChange={(x) => s.set({ prices_include_tax: x })} /></div>
        </div>
        <p className="text-xs text-ink-muted">{t('biz_settings.legal.tax_explain', { example: v.prices_include_tax ? t('biz_settings.legal.incl_example') : t('biz_settings.legal.excl_example') })}</p>
        <SaveBar dirty={s.dirty} busy={s.busy} onSave={() => s.save('legal-tax', { ...v, legal_name: v.legal_name || null, tax_number: v.tax_number || null, legal_address: v.legal_address || null, tax_label: v.tax_label || null, tax_rate_bp: intOf(String(v.tax_rate_bp)) })} />
      </div>
    </Card>
  );
}

/** Payment provider configuration lives on its own page (owned by the payments domain). */
export function PaymentsLink({ slug }: { slug: string }) {
  const { t } = useI18n();
  return (
    <Card title={t('biz_settings.payments.title')}>
      <p className="mb-3 text-sm text-ink-muted">{t('biz_settings.payments.hint')}</p>
      <Link href={`/app/${slug}/settings/payments`} className="inline-flex items-center gap-2 rounded-lg bg-luma-700 px-4 py-2 text-sm text-white hover:bg-luma-800"><CreditCard className="size-4" />{t('biz_settings.payments.open')}<ExternalLink className="size-3.5" /></Link>
    </Card>
  );
}
