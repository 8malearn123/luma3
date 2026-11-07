'use client';

import { useI18n } from '@/i18n/client';
import { Field, Input, Select } from '../components/form';
import { BADGE_PRESET_LABELS, badgeLabel } from '@/shared/badges';

export type BadgeValue = { kind: '' | 'popular' | 'new' | 'offer' | 'custom'; ar: string; en: string };

/** Manual service badge: none, a preset (الأكثر طلباً، جديد، عرض خاص) or custom text, with a live preview. */
export function ServiceBadgeField({ value, onChange }: { value: BadgeValue; onChange: (v: BadgeValue) => void }) {
  const { t, locale } = useI18n();
  const preview = value.kind ? badgeLabel({ kind: value.kind, text_ar: value.ar || null, text_en: value.en || null }, locale) : '';
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('business.badge.label')} hint={t('business.badge.hint')} className="min-w-48 flex-1">{(p) => (
          <Select {...p} value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as BadgeValue['kind'] })}>
            <option value="">{t('business.badge.none')}</option>
            {(Object.keys(BADGE_PRESET_LABELS) as Array<keyof typeof BADGE_PRESET_LABELS>).map((k) => <option key={k} value={k}>{BADGE_PRESET_LABELS[k][locale]}</option>)}
            <option value="custom">{t('business.badge.custom')}</option>
          </Select>
        )}</Field>
        {preview ? <span className="mb-2 rounded-full bg-luma-700 px-2.5 py-0.5 text-xs font-semibold text-white" aria-label={t('business.badge.preview')}>{preview}</span> : null}
      </div>
      {value.kind === 'custom' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('business.badge.text_ar')} required>{(p) => <Input {...p} dir="rtl" maxLength={24} value={value.ar} onChange={(e) => onChange({ ...value, ar: e.target.value })} />}</Field>
          <Field label={t('business.badge.text_en')}>{(p) => <Input {...p} dir="ltr" maxLength={24} value={value.en} onChange={(e) => onChange({ ...value, en: e.target.value })} />}</Field>
        </div>
      ) : null}
    </div>
  );
}
