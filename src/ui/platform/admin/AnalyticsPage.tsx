'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../../hooks';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Card, DataTable, PageHeader, Stat, Tabs } from '../../components/layout';
import { Money, qs } from '../common';
import { CsvLink, lastDays, pct, PeriodPicker, type PeriodValue } from './period';

type Analytics = {
  period: { from: string; to: string; days: number };
  totals: { bookings: number; completed: number; cancelled: number; gmv_minor: number; new_businesses: number };
  bookings_by_category: Array<{ category: string; category_en: string | null; bookings: number; revenue_minor: number }>;
  bookings_by_city: Array<{ city: string; bookings: number; businesses: number }>;
  trial_conversion: { trials: number; converted: number; rate: number | null };
  provider_retention: { booking_active_previous: number; booking_active_both: number; rate: number | null; subscriptions_at_start: number; subscriptions_still_current: number; subscription_rate: number | null };
  average_rating: { average: number | null; reviews: number };
  peak_hours: { by_hour: Array<{ hour: number; bookings: number }>; top: Array<{ hour: number; bookings: number }> };
  revenue: { subscriptions_minor: number; marketplace_fees_minor: number; total_minor: number };
};

const REPORTS = ['monthly_revenue', 'vat_summary', 'provider_performance', 'bookings'] as const;

export function AnalyticsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'analytics' | 'reports'>('analytics');
  const [period, setPeriod] = useState<PeriodValue>(lastDays(30));
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('admin.analytics.title')} subtitle={t('admin.analytics.subtitle')} />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'analytics', label: t('admin.analytics.title') }, { value: 'reports', label: t('admin.reports.title') }]} />
      <PeriodPicker value={period} onChange={setPeriod} />
      {tab === 'analytics' ? <AnalyticsBody period={period} /> : <ReportsBody period={period} />}
    </div>
  );
}

function AnalyticsBody({ period }: { period: PeriodValue }) {
  const { t, locale } = useI18n();
  const path = `/api/v1/platform/analytics${qs(period)}`;
  const q = useApiQuery<Analytics>(['platform', 'analytics', path], path);
  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data!;
  const maxHour = Math.max(1, ...a.peak_hours.by_hour.map((h) => h.bookings));
  return (
    <>
      <div className="flex justify-end"><CsvLink href={`/api/v1/platform/analytics${qs({ ...period, format: 'csv' })}`} /></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label={t('admin.analytics.bookings')} value={a.totals.bookings} />
        <Stat label={t('admin.analytics.completed')} value={a.totals.completed} />
        <Stat label={t('admin.analytics.cancelled')} value={a.totals.cancelled} />
        <Stat label={t('admin.analytics.gmv')} value={<Money minor={a.totals.gmv_minor} />} />
        <Stat label={t('admin.analytics.new_businesses')} value={a.totals.new_businesses} />
      </div>
      <Card title={t('admin.analytics.revenue_title')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label={t('admin.analytics.subscriptions')} value={<Money minor={a.revenue.subscriptions_minor} />} />
          <Stat label={t('admin.analytics.marketplace_fees')} value={<Money minor={a.revenue.marketplace_fees_minor} />} />
          <Stat label={t('admin.analytics.total')} value={<Money minor={a.revenue.total_minor} />} hint={t('admin.analytics.vat_inclusive')} />
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        <Card title={t('admin.analytics.conversion')}>
          <p className="text-3xl font-semibold text-luma-800">{pct(a.trial_conversion.rate)}</p>
          <p className="text-sm text-ink-muted">{t('admin.analytics.converted')}: {a.trial_conversion.converted} / {t('admin.analytics.trials')}: {a.trial_conversion.trials}</p>
        </Card>
        <Card title={t('admin.analytics.retention')}>
          <p className="text-3xl font-semibold text-luma-800">{pct(a.provider_retention.rate)}</p>
          <p className="text-sm text-ink-muted">{t('admin.analytics.retention_bookings')}: {a.provider_retention.booking_active_both} / {a.provider_retention.booking_active_previous}</p>
          <p className="mt-1 text-sm text-ink-muted">{t('admin.analytics.retention_subs')}: {pct(a.provider_retention.subscription_rate)}</p>
        </Card>
        <Card title={t('admin.analytics.rating')}>
          <p className="text-3xl font-semibold text-luma-800">{a.average_rating.average ?? '—'} <span className="text-base">★</span></p>
          <p className="text-sm text-ink-muted">{t('admin.analytics.reviews', { n: a.average_rating.reviews })}</p>
        </Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('admin.analytics.by_category')}>
          {a.bookings_by_category.length ? (
            <DataTable rows={a.bookings_by_category} rowKey={(r) => `${r.category}-${r.category_en}`} caption={t('admin.analytics.by_category')} columns={[
              { key: 'c', header: t('admin.analytics.category'), cell: (r) => (locale === 'ar' ? r.category : r.category_en ?? r.category) },
              { key: 'b', header: t('admin.analytics.bookings'), cell: (r) => r.bookings },
              { key: 'r', header: t('admin.analytics.revenue'), cell: (r) => <Money minor={r.revenue_minor} /> },
            ]} />
          ) : <EmptyState title={t('admin.none')} />}
        </Card>
        <Card title={t('admin.analytics.by_city')}>
          {a.bookings_by_city.length ? (
            <DataTable rows={a.bookings_by_city} rowKey={(r) => r.city} caption={t('admin.analytics.by_city')} columns={[
              { key: 'c', header: t('admin.analytics.city'), cell: (r) => r.city },
              { key: 'b', header: t('admin.analytics.bookings'), cell: (r) => r.bookings },
              { key: 'n', header: t('admin.analytics.businesses'), cell: (r) => r.businesses },
            ]} />
          ) : <EmptyState title={t('admin.none')} />}
        </Card>
      </div>
      <Card title={t('admin.analytics.peak')}>
        {a.peak_hours.top.length ? <p className="mb-3 text-sm text-ink-muted">{t('admin.analytics.peak_top')}: {a.peak_hours.top.map((h) => `${String(h.hour).padStart(2, '0')}:00`).join('، ')}</p> : null}
        <div className="flex h-36 items-end gap-0.5" dir="ltr" role="img" aria-label={t('admin.analytics.peak')}>
          {a.peak_hours.by_hour.map((h) => (
            <div key={h.hour} className="flex flex-1 flex-col items-center gap-1">
              <div className="w-full rounded-t bg-luma-500" style={{ height: `${(h.bookings / maxHour) * 100}%`, minHeight: h.bookings ? 2 : 0 }} title={`${h.hour}:00 — ${h.bookings}`} />
              <span className="text-[9px] text-ink-muted">{h.hour % 3 === 0 ? h.hour : ''}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function ReportsBody({ period }: { period: PeriodValue }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<(typeof REPORTS)[number]>('monthly_revenue');
  const path = `/api/v1/platform/reports/${kind}${qs(period)}`;
  const q = useApiQuery<{ rows: Array<Record<string, unknown>>; note?: string }>(['platform', 'report', path], path);
  return (
    <Card title={t('admin.reports.title')} actions={<CsvLink href={`/api/v1/platform/reports/${kind}${qs({ ...period, format: 'csv' })}`} />}>
      <p className="mb-3 text-sm text-ink-muted">{t('admin.reports.subtitle')}</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {REPORTS.map((k) => (
          <button key={k} onClick={() => setKind(k)} className={`rounded-lg border px-3 py-1.5 text-sm ${kind === k ? 'border-luma-700 bg-luma-50 text-luma-800' : 'border-line'}`}>{t(`admin.reports.kinds.${k}`)}</button>
        ))}
      </div>
      {q.data?.note ? <Alert tone="info" className="mb-3">{q.data.note}</Alert> : null}
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} /> : !q.data!.rows.length ? <EmptyState title={t('admin.none')} /> : (
        <DataTable rows={q.data!.rows.slice(0, 200)} rowKey={(r) => JSON.stringify(r).slice(0, 200)} caption={t(`admin.reports.kinds.${kind}`)}
          columns={Object.keys(q.data!.rows[0]!).filter((k) => k !== 'tenant_id').map((k) => ({
            key: k, header: <span dir="ltr">{k}</span>,
            cell: (r: Record<string, unknown>) => (k.endsWith('_minor') && typeof r[k] === 'number' ? <Money minor={r[k] as number} /> : String(r[k] ?? '—')),
          }))} />
      )}
    </Card>
  );
}
