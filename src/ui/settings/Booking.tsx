'use client';

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { Button } from '../components/button';
import { Alert } from '../components/feedback';
import { Checkbox, Field, Input, MoneyInput, Select, Textarea } from '../components/form';
import { Card } from '../components/layout';
import { formatDateTime } from '@/shared/format';
import { ANY_STAFF_RULES } from '@/shared/schemas/settings';
import { SaveBar, SectionErrors, intOf, useSection, type SettingsData } from './shared';

const FIELDS = ['slot_increment_min', 'min_notice_min', 'max_advance_days', 'hold_ttl_sec', 'no_show_grace_min', 'max_gap_between_items_min', 'any_staff_rule',
  'free_cancellation_hours', 'late_cancellation_fee_bp', 'deposit_mode', 'deposit_percent_bp', 'deposit_fixed_minor', 'allow_full_prepay', 'allow_pay_on_site',
  'booking_requires_account', 'booking_policy_text_ar', 'booking_policy_text_en'] as const;

function NumberField({ label, hint, value, onChange, min, max, suffix }: { label: string; hint?: string; value: number; onChange: (n: number) => void; min: number; max: number; suffix?: string }) {
  return (
    <Field label={label} hint={hint}>{(p) => (
      <div className="flex items-center gap-2">
        <Input {...p} type="number" inputMode="numeric" min={min} max={max} dir="ltr" value={value} onChange={(e) => onChange(intOf(e.target.value))} />
        {suffix ? <span className="shrink-0 text-xs text-ink-muted">{suffix}</span> : null}
      </div>
    )}</Field>
  );
}

export function BookingPolicySection({ slug, data, timeFormat }: { slug: string; data: SettingsData; timeFormat: '12h' | '24h' }) {
  const { t, locale } = useI18n();
  const s = useSection(slug, data, (d) => Object.fromEntries(FIELDS.map((k) => [k, d.settings[k] ?? (k.startsWith('booking_policy_text') ? '' : null)])) as Record<(typeof FIELDS)[number], any>);
  const v = s.values;
  const [reviewed, setReviewed] = useState(false);
  const confirmedAt = data.settings.booking_policy_confirmed_at;
  const save = () => s.save('booking-policy', { ...v, booking_policy_text_ar: v.booking_policy_text_ar || null, booking_policy_text_en: v.booking_policy_text_en || null });
  const min = t('fields.minutes');
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('biz_settings.booking.title')}>
        <div className="flex flex-col gap-4">
          <SectionErrors err={s.err} onReload={s.reload} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('biz_settings.booking.slot_increment')} hint={t('biz_settings.booking.slot_increment_hint')}>{(p) => (
              <Select {...p} value={v.slot_increment_min} onChange={(e) => s.set({ slot_increment_min: Number(e.target.value) })}>{[5, 10, 15, 20, 30, 60].map((n) => <option key={n} value={n}>{n} {min}</option>)}</Select>
            )}</Field>
            <NumberField label={t('biz_settings.booking.min_notice')} hint={t('biz_settings.booking.min_notice_hint')} value={v.min_notice_min} min={0} max={10080} onChange={(n) => s.set({ min_notice_min: n })} suffix={min} />
            <NumberField label={t('biz_settings.booking.max_advance')} value={v.max_advance_days} min={1} max={365} onChange={(n) => s.set({ max_advance_days: n })} suffix={t('biz_settings.days')} />
            <NumberField label={t('biz_settings.booking.hold_ttl')} hint={t('biz_settings.booking.hold_ttl_hint')} value={Math.round(v.hold_ttl_sec / 60)} min={1} max={60} onChange={(n) => s.set({ hold_ttl_sec: n * 60 })} suffix={min} />
            <NumberField label={t('biz_settings.booking.no_show_grace')} hint={t('biz_settings.booking.no_show_grace_hint')} value={v.no_show_grace_min} min={0} max={240} onChange={(n) => s.set({ no_show_grace_min: n })} suffix={min} />
            <NumberField label={t('biz_settings.booking.max_gap')} hint={t('biz_settings.booking.max_gap_hint')} value={v.max_gap_between_items_min} min={0} max={240} onChange={(n) => s.set({ max_gap_between_items_min: n })} suffix={min} />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('biz_settings.booking.any_staff')}</legend>
            {ANY_STAFF_RULES.map((r) => (
              <label key={r} className="flex items-start gap-2 rounded-lg border border-line p-3 text-sm has-[:checked]:border-luma-500 has-[:checked]:bg-luma-50">
                <input type="radio" name="any_staff_rule" className="mt-1 accent-luma-700" checked={v.any_staff_rule === r} onChange={() => s.set({ any_staff_rule: r })} />
                <span><span className="font-medium">{t(`biz_settings.booking.rules.${r}.title`)}</span><span className="block text-xs text-ink-muted">{t(`biz_settings.booking.rules.${r}.explain`)}</span></span>
              </label>
            ))}
          </fieldset>
          <h3 className="text-sm font-semibold">{t('biz_settings.booking.cancellation')}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField label={t('biz_settings.booking.free_cancel')} hint={t('biz_settings.booking.free_cancel_hint')} value={v.free_cancellation_hours} min={0} max={720} onChange={(n) => s.set({ free_cancellation_hours: n })} suffix={t('biz_settings.hours')} />
            <NumberField label={t('biz_settings.booking.late_fee')} hint={t('biz_settings.booking.late_fee_hint')} value={v.late_cancellation_fee_bp / 100} min={0} max={100} onChange={(n) => s.set({ late_cancellation_fee_bp: Math.min(100, n) * 100 })} suffix="%" />
          </div>
          <h3 className="text-sm font-semibold">{t('biz_settings.booking.payment')}</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('biz_settings.booking.deposit_mode')}>{(p) => (
              <Select {...p} value={v.deposit_mode} onChange={(e) => s.set({ deposit_mode: e.target.value })}>{['none', 'percent', 'fixed'].map((m) => <option key={m} value={m}>{t(`biz_settings.booking.deposit.${m}`)}</option>)}</Select>
            )}</Field>
            {v.deposit_mode === 'percent' ? <NumberField label={t('biz_settings.booking.deposit_percent')} value={v.deposit_percent_bp / 100} min={1} max={100} onChange={(n) => s.set({ deposit_percent_bp: Math.min(100, n) * 100 })} suffix="%" /> : null}
            {v.deposit_mode === 'fixed' ? <Field label={t('biz_settings.booking.deposit_fixed')}>{(p) => <MoneyInput {...p} value={v.deposit_fixed_minor} onChange={(m) => s.set({ deposit_fixed_minor: m ?? 0 })} />}</Field> : null}
          </div>
          <div className="flex flex-col gap-2">
            <Checkbox label={t('biz_settings.booking.allow_full_prepay')} checked={v.allow_full_prepay} onChange={(x) => s.set({ allow_full_prepay: x })} />
            <Checkbox label={t('biz_settings.booking.allow_pay_on_site')} checked={v.allow_pay_on_site} onChange={(x) => s.set({ allow_pay_on_site: x })} />
            <Checkbox label={t('biz_settings.booking.requires_account')} description={t('biz_settings.booking.requires_account_hint')} checked={v.booking_requires_account} onChange={(x) => s.set({ booking_requires_account: x })} />
          </div>
          <p className="text-xs text-ink-muted">{t('biz_settings.booking.payments_note')}</p>
          <h3 className="text-sm font-semibold">{t('biz_settings.booking.policy_text')}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('biz_settings.booking.text_ar')}>{(p) => <Textarea {...p} dir="rtl" rows={5} maxLength={5000} value={v.booking_policy_text_ar} onChange={(e) => s.set({ booking_policy_text_ar: e.target.value })} />}</Field>
            <Field label={t('biz_settings.booking.text_en')}>{(p) => <Textarea {...p} dir="ltr" rows={5} maxLength={5000} value={v.booking_policy_text_en} onChange={(e) => s.set({ booking_policy_text_en: e.target.value })} />}</Field>
          </div>
          <p className="text-xs text-ink-muted">{t('biz_settings.booking.snapshot_note')}</p>
          <SaveBar dirty={s.dirty} busy={s.busy} onSave={save} />
        </div>
      </Card>
      <Card title={t('biz_settings.booking.review_title')}>
        {confirmedAt && !s.dirty ? (
          <Alert tone="ok" title={t('biz_settings.booking.reviewed_on', { date: formatDateTime(confirmedAt, { locale, timeFormat, tz: data.tenant.timezone }) })}>{t('biz_settings.booking.reviewed_hint')}</Alert>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">{t('biz_settings.booking.review_body')}</p>
            {s.dirty ? <Alert tone="warn">{t('biz_settings.booking.save_first')}</Alert> : null}
            <Checkbox label={t('biz_settings.booking.review_check')} checked={reviewed} disabled={s.dirty} onChange={setReviewed} />
            <Button className="self-start" icon={<CheckCircle2 className="size-4" />} disabled={!reviewed || s.dirty} loading={s.busy}
              onClick={async () => { const r = await s.save('booking-policy/confirm', { confirmed: true }, 'POST'); if (r) setReviewed(false); }}>{t('biz_settings.booking.confirm')}</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
