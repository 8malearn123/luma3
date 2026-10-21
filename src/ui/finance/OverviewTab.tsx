'use client';

import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { BarList } from '../analytics/charts';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { TestValueBadge, isTestLabel } from '../engagement/shared';
import { DailyBars, PeriodPicker, usePeriod } from './common';
import { cx } from '../components/cx';

type Amount = { amount_minor: number | null };
export type Report = {
  period: { from: string; to: string; timezone: string };
  booking_value: Amount & { count: number };
  completed_service_sales: Amount; product_sales: Amount;
  collections: { by_method: Array<{ method: string; v: number }>; total_minor: number };
  deposits_outstanding: Amount; receivables: Amount;
  refunds: { completed_minor: number; pending_minor: number };
  discounts: Amount; provider_fees: Amount;
  expenses: { by_category: Array<{ category: string; v: number }>; total_minor: number };
  product_costs: Amount & { complete: boolean; missing_lines: number };
  material_costs: Amount & { complete: boolean };
  commissions: Amount;
  profit: { status: 'computed' | 'costs_incomplete'; amount_minor: number | null; missing?: string[] };
  tax: { collected_minor: number; configured: { tax_label: string | null; tax_rate_bp: number; prices_include_tax: boolean } | null };
  daily: Array<{ date: string; collections_minor: number; expenses_minor: number }>;
};

function Tile({ label, value, hint, tone, badge }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'warn' | 'muted'; badge?: ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl border border-line bg-white p-3 sm:p-4">
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">{label}{badge}</p>
      <p className={cx('mt-1 text-xl font-semibold tabular-nums sm:text-2xl', tone === 'warn' ? 'text-warn' : tone === 'muted' ? 'text-ink-muted' : 'text-luma-900')}><bdi>{value}</bdi></p>
      {hint ? <p className="mt-1 text-[11px] leading-snug text-ink-muted">{hint}</p> : null}
    </div>
  );
}

export function OverviewTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const { period, setPeriod, valid } = usePeriod('last_30');
  const q = useApiQuery<Report>(['fin-report', access.slug, period.from, period.to], valid ? access.api(`/finance/report?from=${period.from}&to=${period.to}`) : null);
  const r = q.data;

  return (
    <div className="flex flex-col gap-4">
      <PeriodPicker value={period} onChange={setPeriod} />
      {!valid ? <Alert tone="warn">{t('fe.period.invalid')}</Alert> : q.isLoading ? <LoadingState rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : r ? (
        <>
          {/* Honesty first: profit is never shown as complete when cost inputs are missing. */}
          {r.profit.status === 'costs_incomplete' ? (
            <div role="status" className="flex gap-3 rounded-xl border-2 border-warn/40 bg-warn-bg p-4">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
              <div className="text-sm">
                <p className="font-semibold text-warn">{t('finance.costs_incomplete')}</p>
                <p className="mt-1 text-ink/80">{t('fe.overview.incomplete_body')}</p>
                {r.profit.missing?.length ? (
                  <>
                    <p className="mt-2 font-medium">{t('finance.missing')}:</p>
                    <ul className="list-disc ps-5">{r.profit.missing.map((m) => <li key={m}>{t(`fe.missing.${m}`)}</li>)}</ul>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          <section aria-label={t('fe.overview.summary')} className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            <Tile label={t('finance.service_sales')} value={money(r.completed_service_sales.amount_minor)} hint={t('fe.basis.service_sales')} />
            <Tile label={t('finance.product_sales')} value={money(r.product_sales.amount_minor)} hint={t('fe.basis.product_sales')} />
            <Tile label={t('finance.collections')} value={money(r.collections.total_minor)} hint={t('fe.basis.collections')} />
            <Tile label={t('finance.booking_value')} value={money(r.booking_value.amount_minor)} hint={t('fe.basis.booking_value', { n: r.booking_value.count })} />
            <Tile label={t('fe.overview.tax_collected')} value={money(r.tax.collected_minor)} hint={t('fe.basis.tax')} />
            <Tile label={t('finance.discounts')} value={money(r.discounts.amount_minor)} />
            <Tile label={t('finance.refunds_done')} value={money(r.refunds.completed_minor)} hint={r.refunds.pending_minor ? t('fe.overview.refunds_pending', { amount: money(r.refunds.pending_minor) }) : undefined} tone={r.refunds.pending_minor ? 'warn' : undefined} />
            <Tile label={t('finance.expenses')} value={money(r.expenses.total_minor)} hint={t('fe.basis.expenses')} />
            <Tile label={t('finance.commissions')} value={money(r.commissions.amount_minor)} hint={t('fe.basis.commissions')} />
            <Tile label={t('finance.product_costs')} value={money(r.product_costs.amount_minor)} tone={r.product_costs.complete ? undefined : 'warn'}
              badge={r.product_costs.complete ? null : <Badge tone="warn">{t('fe.overview.incomplete')}</Badge>} hint={r.product_costs.complete ? undefined : t('fe.overview.missing_lines', { n: r.product_costs.missing_lines })} />
            <Tile label={t('finance.material_costs')} value={money(r.material_costs.amount_minor)} tone={r.material_costs.complete ? undefined : 'warn'}
              badge={r.material_costs.complete ? null : <Badge tone="warn">{t('fe.overview.incomplete')}</Badge>} />
            <Tile label={t('finance.fees')} value={r.provider_fees.amount_minor == null ? t('finance.not_reported') : money(r.provider_fees.amount_minor)} tone="muted" hint={t('fe.basis.fees')} />
            <Tile label={t('finance.deposits')} value={money(r.deposits_outstanding.amount_minor)} hint={t('fe.basis.deposits')} />
            <Tile label={t('finance.receivables')} value={money(r.receivables.amount_minor)} hint={t('fe.basis.receivables')} />
            <div className="col-span-2">
              {r.profit.status === 'computed' ? (
                <Tile label={t('fe.overview.net')} value={money(r.profit.amount_minor)} hint={`${t('finance.formula')}: ${t('fe.overview.formula')}`} />
              ) : (
                <Tile label={t('fe.overview.net')} value={t('fe.overview.not_computed')} tone="warn" badge={<Badge tone="warn">{t('fe.overview.incomplete')}</Badge>} hint={t('finance.costs_incomplete')} />
              )}
            </div>
          </section>

          <Card title={t('fe.overview.daily_collections')}>
            <DailyBars label={t('fe.overview.daily_collections')} currency={access.currency} points={r.daily.map((d) => ({ date: d.date, value: d.collections_minor }))} />
            <p className="mt-2 text-xs text-ink-muted">{t('fe.overview.chart_note', { tz: r.period.timezone })}</p>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card title={t('fe.overview.by_method')}>
              <BarList label={t('fe.overview.by_method')} empty={t('fe.overview.none')} format={(v) => money(v)}
                items={r.collections.by_method.map((m) => ({ key: m.method, label: t(`fe.methods.${m.method}`), value: Number(m.v) }))} />
            </Card>
            <Card title={t('fe.overview.by_category')}>
              <BarList label={t('fe.overview.by_category')} empty={t('fe.overview.none')} format={(v) => money(v)}
                items={r.expenses.by_category.map((c) => ({ key: c.category, label: t(`finance.categories.${c.category}`), value: Number(c.v) }))} />
            </Card>
          </div>

          <Card title={<span className="inline-flex items-center gap-2">{t('fe.overview.tax_settings')}{isTestLabel(r.tax.configured?.tax_label) ? <TestValueBadge /> : null}</span>}>
            {r.tax.configured ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <div><dt className="text-xs text-ink-muted">{t('fe.overview.tax_label')}</dt><dd>{r.tax.configured.tax_label || '—'}</dd></div>
                <div><dt className="text-xs text-ink-muted">{t('fe.overview.tax_rate')}</dt><dd><bdi>{(r.tax.configured.tax_rate_bp / 100).toFixed(2)}%</bdi></dd></div>
                <div><dt className="text-xs text-ink-muted">{t('fe.overview.prices_include_tax')}</dt><dd>{r.tax.configured.prices_include_tax ? t('fe.common.yes') : t('fe.common.no')}</dd></div>
              </dl>
            ) : null}
            <Alert tone="info" className="mt-3">{t('finance.tax_note')} {t('fe.overview.tax_disclaimer')}</Alert>
          </Card>
        </>
      ) : null}
    </div>
  );
}
