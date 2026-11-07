'use client';

import { useI18n } from '@/i18n/client';
import { Checkbox, Field, Input } from '../components/form';
import { Card } from '../components/layout';
import { cx } from '../components/cx';
import { SaveBar, SectionErrors, useSection, type SettingsData } from './shared';

type Mode = 'off' | 'immediately' | 'after_hours';

/** «طلب التقييم بعد الزيارة»: the owner chooses the timing (or turns it off) and an optional reminder. */
export function ReviewRequestSection({ slug, data }: { slug: string; data: SettingsData }) {
  const { t } = useI18n();
  const s = useSection(slug, data, (d) => ({
    mode: (d.settings.review_request_mode ?? 'after_hours') as Mode,
    delay: String(d.settings.review_request_delay_hours ?? 3),
    reminder: d.settings.review_reminder_hours != null,
    reminderHours: String(d.settings.review_reminder_hours ?? 24),
  }));
  const v = s.values;
  const clamp = (x: string, max: number) => Math.min(max, Math.max(1, Math.trunc(Number(x) || 1)));
  return (
    <Card title={t('customer.review_request.title')}>
      <div className="flex flex-col gap-3">
        <SectionErrors err={s.err} onReload={s.reload} />
        <p className="text-sm text-ink-muted">{t('customer.review_request.hint')}</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{t('customer.review_request.timing')}</legend>
          {(['off', 'immediately', 'after_hours'] as const).map((m) => (
            <label key={m} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm', v.mode === m ? 'border-luma-500 bg-luma-50' : 'border-line')}>
              <input type="radio" name="review_request_mode" className="accent-luma-700" checked={v.mode === m} onChange={() => s.set({ mode: m })} />
              {t(`customer.review_request.mode.${m}`)}
            </label>
          ))}
        </fieldset>
        {v.mode === 'after_hours' ? (
          <Field label={t('customer.review_request.delay')} hint={t('customer.review_request.delay_hint')}>
            {(p) => <Input {...p} type="number" min={1} max={168} dir="ltr" className="max-w-32" value={v.delay} onChange={(e) => s.set({ delay: e.target.value })} />}
          </Field>
        ) : null}
        {v.mode !== 'off' ? (
          <div className="flex flex-col gap-2">
            <Checkbox label={t('customer.review_request.reminder')} description={t('customer.review_request.reminder_hint')} checked={v.reminder} onChange={(on) => s.set({ reminder: on })} />
            {v.reminder ? (
              <Field label={t('customer.review_request.reminder_after')}>
                {(p) => <Input {...p} type="number" min={1} max={336} dir="ltr" className="max-w-32" value={v.reminderHours} onChange={(e) => s.set({ reminderHours: e.target.value })} />}
              </Field>
            ) : null}
          </div>
        ) : null}
        <SaveBar dirty={s.dirty} busy={s.busy} onSave={() => s.save('review-requests', {
          review_request_mode: v.mode, review_request_delay_hours: clamp(v.delay, 168), review_reminder_hours: v.mode !== 'off' && v.reminder ? clamp(v.reminderHours, 336) : null,
        })} />
      </div>
    </Card>
  );
}
