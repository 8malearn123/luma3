'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Check, Minus, Sparkles } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDate, formatMoney } from '@/shared/format';
import { PLAN_FEATURES } from '@/shared/plans';

type Cycle = { cycle: 'monthly' | 'yearly'; list_minor: number | null; founding_minor: number | null; promo_minor: number | null; promotion: { name_ar: string; name_en: string; discount_bp: number; ends_at: string; code: string | null } | null };
export type PricingPlan = {
  id: string; code: string; name_ar: string; name_en: string; description_ar: string | null; description_en: string | null; currency: string; trial_days: number;
  price_is_test: boolean; yearly_saving_minor: number | null; cycles: Cycle[]; features: Record<string, { enabled: boolean; limit: number | null }>;
};
export type PricingData = { founding: { enabled: boolean; total: number; remaining: number; discount_bp: number }; plans: PricingPlan[] };

/** Public plans with a monthly / yearly toggle (yearly = two months free) and the founding offer. */
export function PricingPlans({ data, promo }: { data: PricingData; promo?: string }) {
  const { t, locale, pick } = useI18n();
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const keys = Object.keys(PLAN_FEATURES) as Array<keyof typeof PLAN_FEATURES>;
  const money = (m: number, c: string) => formatMoney(m, c, locale);
  const founding = data.founding.enabled && data.founding.remaining > 0;
  return (
    <>
      <div className="mt-6 flex flex-col items-center gap-3">
        <div role="radiogroup" aria-label={t('pricing.billing_cycle')} className="inline-flex rounded-full border border-luma-200 bg-white p-1">
          {(['monthly', 'yearly'] as const).map((c) => (
            <button key={c} role="radio" aria-checked={cycle === c} onClick={() => setCycle(c)}
              className={`rounded-full px-5 py-2 text-sm font-medium ${cycle === c ? 'bg-luma-700 text-white' : 'text-ink'}`}>
              {t(`pricing.${c}`)}{c === 'yearly' ? <span className={`ms-2 rounded-full px-2 py-0.5 text-xs ${cycle === c ? 'bg-white/20' : 'bg-luma-100 text-luma-800'}`}>{t('pricing.yearly_badge')}</span> : null}
            </button>
          ))}
        </div>
        {founding ? (
          <p className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-4 py-1.5 text-sm text-amber-900">
            <Sparkles className="size-4" aria-hidden />{t('pricing.founding_left', { n: data.founding.remaining, total: data.founding.total, pct: data.founding.discount_bp / 100 })}
          </p>
        ) : null}
        <p className="text-xs text-ink-muted">{t('pricing.vat')} · {t('pricing.no_booking_limit')}</p>
      </div>
      <div className="mt-8 grid gap-5 md:grid-cols-3">
        {data.plans.map((p) => {
          const c = p.cycles.find((x) => x.cycle === cycle)!;
          const per = cycle === 'yearly' ? t('pricing.per_year') : t('site.per_month');
          const best = c.promo_minor != null && (c.founding_minor == null || c.promo_minor < c.founding_minor) ? c.promo_minor : null;
          const choose = `/app/new?plan=${p.code}&cycle=${cycle}${promo ? `&promo=${encodeURIComponent(promo)}` : ''}`;
          return (
            <article key={p.id} className="flex flex-col rounded-3xl border border-luma-200 bg-white p-6">
              <h2 className="font-display text-2xl text-luma-700">{pick(p.name_ar, p.name_en)}</h2>
              <p className="mt-1 text-sm text-ink-muted">{pick(p.description_ar, p.description_en)}</p>
              {c.list_minor == null ? <p className="mt-4 text-base text-ink-muted">{t('site.price_not_set')}</p> : (
                <div className="mt-4">
                  <p className="text-2xl font-semibold">
                    <span className={founding || best != null ? 'text-base text-ink-muted line-through' : ''}>{money(c.list_minor, p.currency)}</span>
                    {founding && c.founding_minor != null ? <span className="ms-2">{money(c.founding_minor, p.currency)}</span> : best != null ? <span className="ms-2">{money(best, p.currency)}</span> : null}
                    <span className="ms-1 text-sm font-normal">{per}</span>
                  </p>
                  {founding && c.founding_minor != null ? <p className="text-xs text-amber-800">{t('pricing.founding_badge')} · {t('pricing.founding_note')}</p> : null}
                  {c.promotion ? <p className="mt-1 text-xs text-ok">{t('pricing.promo', { name: pick(c.promotion.name_ar, c.promotion.name_en), pct: c.promotion.discount_bp / 100 })} · {t('pricing.promo_until', { date: formatDate(c.promotion.ends_at, { locale }) })}</p> : null}
                  {cycle === 'yearly' && p.yearly_saving_minor ? <p className="text-xs text-luma-700">{t('pricing.save', { amount: money(p.yearly_saving_minor, p.currency) })}</p> : null}
                  {p.price_is_test ? <p className="text-xs text-warn">{t('site.price_test')}</p> : null}
                </div>
              )}
              <p className="text-xs text-ink-muted">{t('site.trial_days', { n: p.trial_days })}</p>
              <ul className="mt-4 flex flex-1 flex-col gap-1.5 text-sm">
                <li className="flex items-center gap-2"><Check className="size-4 text-ok" aria-hidden />{t('pricing.no_booking_limit')}</li>
                {keys.map((k) => {
                  const f = p.features[k];
                  const meta = PLAN_FEATURES[k];
                  const on = !!f?.enabled;
                  return (
                    <li key={k} className="flex items-center gap-2">
                      {on ? <Check className="size-4 text-ok" aria-label={t('site.included')} /> : <Minus className="size-4 text-ink-muted" aria-label={t('site.not_included')} />}
                      <span className={on ? '' : 'text-ink-muted'}>{locale === 'ar' ? meta.label_ar : meta.label_en}{meta.kind === 'limit' && on ? `: ${f?.limit ?? t('site.unlimited')}` : ''}</span>
                    </li>
                  );
                })}
              </ul>
              <Link href={`/auth/register?next=${encodeURIComponent(choose)}`} className="mt-6 rounded-xl bg-luma-700 px-4 py-2.5 text-center text-sm font-medium text-white">{t('site.choose')}</Link>
            </article>
          );
        })}
      </div>
    </>
  );
}
