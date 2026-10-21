'use client';

import { useI18n } from '@/i18n/client';
import { Field, Input, Select } from '../components/form';
import { Card } from '../components/layout';
import { SOCIAL_NETWORKS } from '@/shared/schemas/settings';
import { SaveBar, SectionErrors, useSection, type SettingsData } from './shared';

const COMMON_TZ = ['Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Muscat', 'Africa/Cairo', 'Asia/Amman', 'Europe/London', 'UTC'];

export function ProfileSection({ slug, data }: { slug: string; data: SettingsData }) {
  const { t } = useI18n();
  const s = useSection(slug, data, (d) => ({
    name: d.tenant.name, city: d.tenant.city ?? '', default_locale: d.tenant.default_locale, timezone: d.tenant.timezone,
    contact_phone: d.settings.contact_phone ?? '', contact_email: d.settings.contact_email ?? '', contact_whatsapp: d.settings.contact_whatsapp ?? '',
    social: Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, d.settings.social_links?.[n] ?? ''])) as Record<string, string>,
  }));
  const v = s.values;
  const save = () => s.save('profile', {
    name: v.name, city: v.city || null, default_locale: v.default_locale, timezone: v.timezone,
    contact_phone: v.contact_phone || null, contact_email: v.contact_email || null, contact_whatsapp: v.contact_whatsapp || null,
    social_links: Object.fromEntries(Object.entries(v.social).map(([k, x]) => [k, x.trim() || null])),
  });
  const tzOptions = COMMON_TZ.includes(v.timezone) ? COMMON_TZ : [v.timezone, ...COMMON_TZ];
  return (
    <Card title={t('biz_settings.profile.title')}>
      <div className="flex flex-col gap-4">
        <SectionErrors err={s.err} onReload={s.reload} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('biz_settings.profile.name')} required>{(p) => <Input {...p} value={v.name} maxLength={120} onChange={(e) => s.set({ name: e.target.value })} />}</Field>
          <Field label={t('biz_settings.profile.city')}>{(p) => <Input {...p} value={v.city} maxLength={80} onChange={(e) => s.set({ city: e.target.value })} />}</Field>
          <Field label={t('biz_settings.profile.locale')} hint={t('biz_settings.profile.locale_hint')}>{(p) => (
            <Select {...p} value={v.default_locale} onChange={(e) => s.set({ default_locale: e.target.value as 'ar' | 'en' })}><option value="ar">العربية</option><option value="en">English</option></Select>
          )}</Field>
          <Field label={t('biz_settings.profile.timezone')} hint={t('biz_settings.profile.timezone_hint')}>{(p) => (
            <Select {...p} value={v.timezone} onChange={(e) => s.set({ timezone: e.target.value })}>{tzOptions.map((z) => <option key={z} value={z}>{z}</option>)}</Select>
          )}</Field>
        </div>
        <h3 className="text-sm font-semibold">{t('biz_settings.profile.contact')}</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('fields.phone')} hint={t('biz_settings.profile.phone_hint')}>{(p) => <Input {...p} dir="ltr" inputMode="tel" value={v.contact_phone} onChange={(e) => s.set({ contact_phone: e.target.value })} />}</Field>
          <Field label={t('biz_settings.profile.whatsapp')}>{(p) => <Input {...p} dir="ltr" inputMode="tel" value={v.contact_whatsapp} onChange={(e) => s.set({ contact_whatsapp: e.target.value })} />}</Field>
          <Field label={t('fields.email')}>{(p) => <Input {...p} dir="ltr" type="email" value={v.contact_email} onChange={(e) => s.set({ contact_email: e.target.value })} />}</Field>
        </div>
        <h3 className="text-sm font-semibold">{t('biz_settings.profile.social')}</h3>
        <p className="-mt-2 text-xs text-ink-muted">{t('biz_settings.profile.social_hint')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {SOCIAL_NETWORKS.map((n) => (
            <Field key={n} label={t(`biz_settings.social.${n}`)}>{(p) => (
              <div className="relative"><span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-sm text-ink-muted" dir="ltr">@</span>
                <Input {...p} dir="ltr" className="ps-7" value={v.social[n]} onChange={(e) => s.set({ social: { ...v.social, [n]: e.target.value.replace(/^@/, '') } })} /></div>
            )}</Field>
          ))}
        </div>
        <SaveBar dirty={s.dirty} busy={s.busy} onSave={save} />
      </div>
    </Card>
  );
}
