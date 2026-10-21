import Link from 'next/link';
import { Check, Minus } from 'lucide-react';
import { db } from '@/server/db/client';
import { getT } from '@/i18n/server';
import { pick } from '@/i18n';
import { SiteFooter, SiteHeader } from '@/ui/marketing/SiteHeader';
import { PLAN_FEATURES } from '@/shared/plans';
import { formatMoney } from '@/shared/format';

export const metadata = { title: 'Plans' };
export const dynamic = 'force-dynamic';

/** Plans and the feature matrix come from the database (editable by the LUMA owner). */
export default async function Pricing() {
  const { t, locale } = await getT();
  const plans = await db().selectFrom('plans').selectAll().where('status', '=', 'active').orderBy('sort').execute();
  const features = await db().selectFrom('plan_features').selectAll().execute();
  const keys = Object.keys(PLAN_FEATURES) as Array<keyof typeof PLAN_FEATURES>;
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-12">
        <h1 className="text-center text-3xl font-semibold text-luma-900">{t('site.pricing_title')}</h1>
        <p className="mt-2 text-center text-ink-muted">{t('site.pricing_sub')}</p>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {plans.map((p) => (
            <article key={p.id} className="flex flex-col rounded-3xl border border-luma-200 bg-white p-6">
              <h2 className="font-display text-2xl text-luma-700">{pick(locale, p.name_ar, p.name_en)}</h2>
              <p className="mt-1 text-sm text-ink-muted">{pick(locale, p.description_ar, p.description_en)}</p>
              <p className="mt-4 text-xl font-semibold">
                {p.price_monthly_minor == null ? <span className="text-base text-ink-muted">{t('site.price_not_set')}</span> : <>{formatMoney(p.price_monthly_minor, p.currency, locale)} <span className="text-sm font-normal">{t('site.per_month')}</span></>}
              </p>
              {p.price_monthly_minor != null && p.price_is_test ? <p className="text-xs text-warn">{t('site.price_test')}</p> : null}
              <p className="text-xs text-ink-muted">{t('site.trial_days', { n: p.trial_days })}</p>
              <ul className="mt-4 flex flex-1 flex-col gap-1.5 text-sm">
                {keys.map((k) => {
                  const f = features.find((x) => x.plan_id === p.id && x.feature_key === k);
                  const meta = PLAN_FEATURES[k];
                  const on = !!f?.enabled;
                  return (
                    <li key={k} className="flex items-center gap-2">
                      {on ? <Check className="size-4 text-ok" aria-label={t('site.included')} /> : <Minus className="size-4 text-ink-muted" aria-label={t('site.not_included')} />}
                      <span className={on ? '' : 'text-ink-muted'}>{locale === 'ar' ? meta.label_ar : meta.label_en}
                        {meta.kind === 'limit' && on ? `: ${f?.limit_value ?? t('site.unlimited')}` : ''}</span>
                    </li>
                  );
                })}
              </ul>
              <Link href={`/auth/register?next=${encodeURIComponent(`/app/new?plan=${p.code}`)}`} className="mt-6 rounded-xl bg-luma-700 px-4 py-2.5 text-center text-sm font-medium text-white">{t('site.choose')}</Link>
            </article>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
