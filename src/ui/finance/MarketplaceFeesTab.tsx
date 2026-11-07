'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, DataTable, Stat } from '../components/layout';
import { useAccess } from '../shell/access-context';
import { PeriodPicker, usePeriod } from './common';

type Fees = {
  currency: string; bookings: number; base_minor: number; fee_minor: number; simulated_fee_minor: number; pending_fee_minor: number;
  lines: Array<{ id: string; booking_id: string; booking_number: string; base_minor: number; rate_bp: number; fee_minor: number; settlement: string; created_at: string }>;
};

/** Finance → «عمولة سوق لوما»: LUMA's commission on bookings that came from the marketplace only. */
export function MarketplaceFeesTab() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { period, setPeriod, valid } = usePeriod('this_month');
  const q = useApiQuery<Fees>(['fin-market-fees', access.slug, period.from, period.to], valid ? access.api(`/finance/marketplace-fees?from=${period.from}&to=${period.to}`) : null);
  const money = (m: number) => formatMoney(m, q.data?.currency ?? access.currency, locale);
  return (
    <div className="flex flex-col gap-4">
      <PeriodPicker value={period} onChange={setPeriod} />
      <Alert tone="info">{t('market.finance.explainer')}</Alert>
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label={t('market.finance.bookings')} value={q.data.bookings} />
            <Stat label={t('market.finance.base')} value={money(q.data.base_minor)} />
            <Stat label={t('market.finance.fee')} value={money(q.data.fee_minor)} hint={q.data.simulated_fee_minor ? t('market.finance.simulated_hint') : undefined} />
          </div>
          <Card title={t('market.finance.title')}>
            {!q.data.lines.length ? <EmptyState title={t('market.finance.empty')} /> : (
              <DataTable rows={q.data.lines} rowKey={(r) => r.id} caption={t('market.finance.title')} columns={[
                { key: 'date', header: t('market.finance.date'), cell: (r) => <span className="whitespace-nowrap text-xs">{formatDateTime(r.created_at, { locale, tz: access.timezone })}</span> },
                { key: 'booking', header: t('market.finance.booking'), cell: (r) => <Link className="text-luma-700 underline" href={`/app/${access.slug}/bookings?booking=${r.booking_id}`} dir="ltr">{r.booking_number}</Link> },
                { key: 'base', header: t('market.finance.base'), cell: (r) => money(r.base_minor) },
                { key: 'rate', header: t('market.finance.rate'), cell: (r) => `${r.rate_bp / 100}%` },
                { key: 'fee', header: t('market.finance.fee'), cell: (r) => <span className="font-medium">{money(r.fee_minor)}</span> },
                { key: 'st', header: t('market.finance.settlement'), cell: (r) => <Badge tone={r.settlement === 'pending' ? 'warn' : 'neutral'}>{t(`market.settlement.${r.settlement}`)}</Badge> },
              ]} />
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
