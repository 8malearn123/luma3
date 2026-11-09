'use client';

import Link from 'next/link';
import { Award, Gift } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';

type Tier = { code: string; name_ar: string; name_en: string; min_lifetime_points: number };
type Reward = { id: string; name_ar: string | null; name_en: string | null; points_cost: number; kind: string; value: number; redeemable: boolean };
type Row = {
  tenant_id: string; tenant_name: string; tenant_slug: string; enabled: boolean; balance: number; lifetime_earned: number;
  tier: Tier | null; next_tier: Tier | null; points_to_next: number | null; points_per_sar: number; expires_at: string | null; rewards: Reward[];
};

/** «نقاطي»: points balance and tier at each business she deals with. */
export function LoyaltyPanel() {
  const { t, locale, pick, timeFormat } = useI18n();
  const q = useApiQuery<Row[]>(['account-loyalty'], '/api/v1/account/loyalty');
  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <EmptyState icon={<Award className="size-8" aria-hidden />} title={t('customer.loyalty.empty')} hint={t('customer.loyalty.empty_hint')} />;
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {q.data.map((r) => {
        const progress = r.next_tier ? Math.min(100, Math.round((r.lifetime_earned / r.next_tier.min_lifetime_points) * 100)) : 100;
        return (
          <li key={r.tenant_id} className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-luma-900">{r.tenant_name}</p>
                {r.tier ? <Badge tone="ok">{t('customer.loyalty.tier', { name: pick(r.tier.name_ar, r.tier.name_en) })}</Badge> : <span className="text-xs text-ink-muted">{t('customer.loyalty.no_tier')}</span>}
              </div>
              <div className="text-end">
                <p className="font-display text-2xl text-luma-800" dir="ltr">{r.balance.toLocaleString(locale === 'ar' ? 'ar-SA' : 'en-US')}</p>
                <p className="text-xs text-ink-muted">{t('customer.loyalty.points')}</p>
              </div>
            </div>
            {r.next_tier ? (
              <div>
                <div className="h-2 overflow-hidden rounded-full bg-luma-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={t('customer.loyalty.progress')}>
                  <div className="h-full rounded-full bg-luma-600" style={{ width: `${progress}%` }} />
                </div>
                <p className="mt-1 text-xs text-ink-muted">{t('customer.loyalty.to_next', { n: r.points_to_next ?? 0, name: pick(r.next_tier.name_ar, r.next_tier.name_en) })}</p>
              </div>
            ) : null}
            {!r.enabled ? <p className="text-xs text-ink-muted">{t('customer.loyalty.paused')}</p> : r.points_per_sar ? <p className="text-xs text-ink-muted">{t('customer.loyalty.earn_rate', { n: r.points_per_sar })}</p> : null}
            {r.expires_at ? <p className="text-xs text-ink-muted">{t('customer.loyalty.expires', { date: formatDateTime(r.expires_at, { locale, timeFormat, time: false }) })}</p> : null}
            {r.rewards.length ? (
              <ul className="flex flex-col gap-1 border-t border-line pt-2 text-sm">
                {r.rewards.slice(0, 4).map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1"><Gift className="size-3.5 text-luma-600" aria-hidden />{pick(w.name_ar, w.name_en)} · {w.kind === 'percent_discount' ? `${w.value / 100}%` : formatMoney(w.value, 'SAR', locale)}</span>
                    <span className={w.redeemable ? 'text-luma-700' : 'text-ink-muted'}>{t('customer.loyalty.cost', { n: w.points_cost })}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <Link href={`/s/${r.tenant_slug}`} className="text-sm text-luma-700 hover:underline">{t('customer.loyalty.visit')}</Link>
          </li>
        );
      })}
    </ul>
  );
}
