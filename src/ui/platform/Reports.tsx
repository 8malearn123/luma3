'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Select } from '../components/form';
import { Card, DataTable, PageHeader, Stat } from '../components/layout';
import { Money, PageNav, TestBadge, Toolbar, When, qs } from './common';

type Rev = {
  is_test: boolean; note: string; estimated_mrr_minor: number; active_on_unpriced_plans: number;
  monthly: Array<{ month: string; paid_minor: number; open_minor: number; void_minor: number; invoices: number; currency: string }>;
  by_plan: Array<{ code: string; name_ar: string; name_en: string; price_monthly_minor: number | null; price_is_test: boolean; active: number; trialing: number; past_due: number }>;
};
type Inv = { id: string; number: string; amount_minor: number; currency: string; status: string; issued_at: string | null; paid_at: string | null; tenant_slug: string; tenant_name: string; plan_code: string | null };

export function RevenuePage() {
  const { t, pick } = useI18n();
  const [months, setMonths] = useState('6');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const r = useApiQuery<Rev>(['platform', 'revenue', months], `/api/v1/platform/revenue?months=${months}`);
  const invPath = `/api/v1/platform/invoices${qs({ status, page, limit: 25 })}`;
  const inv = useApiQuery<{ items: Inv[]; total: number }>(['platform', 'invoices', invPath], invPath);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('platform.revenue.title')} subtitle={t('platform.revenue.subtitle')} actions={<TestBadge />} />
      <Alert tone="warn">{t('platform.revenue.separate')}</Alert>
      {r.isLoading ? <LoadingState /> : r.error ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Stat label={t('platform.revenue.mrr')} value={<Money minor={r.data!.estimated_mrr_minor} />} hint={t('platform.revenue.mrr_hint')} />
            <Stat label={t('platform.revenue.paid_total')} value={<Money minor={r.data!.monthly.reduce((a, m) => a + m.paid_minor, 0)} />} hint={t('platform.revenue.months', { n: months })} />
            <Stat label={t('platform.revenue.unpriced')} value={r.data!.active_on_unpriced_plans} hint={t('platform.pricing_not_configured')} />
          </div>
          <Card title={t('platform.revenue.monthly')} actions={
            <Select aria-label={t('platform.revenue.range')} className="w-auto" value={months} onChange={(e) => setMonths(e.target.value)}>{['3', '6', '12', '24'].map((m) => <option key={m} value={m}>{t('platform.revenue.months', { n: m })}</option>)}</Select>
          }>
            {r.data!.monthly.length ? (
              <DataTable rows={r.data!.monthly} rowKey={(m) => `${m.month}-${m.currency}`} caption={t('platform.revenue.monthly')} columns={[
                { key: 'month', header: t('platform.revenue.month'), cell: (m) => <span dir="ltr">{m.month}</span> },
                { key: 'paid', header: t('platform.invoice_status.paid'), cell: (m) => <Money minor={m.paid_minor} currency={m.currency} /> },
                { key: 'open', header: t('platform.invoice_status.open'), cell: (m) => <Money minor={m.open_minor} currency={m.currency} /> },
                { key: 'void', header: t('platform.invoice_status.void'), className: 'hidden sm:table-cell', cell: (m) => <Money minor={m.void_minor} currency={m.currency} /> },
                { key: 'n', header: t('platform.revenue.invoices'), cell: (m) => m.invoices },
              ]} />
            ) : <EmptyState title={t('platform.revenue.no_invoices')} />}
          </Card>
          <Card title={t('platform.revenue.by_plan')}>
            <DataTable rows={r.data!.by_plan} rowKey={(p) => p.code} caption={t('platform.revenue.by_plan')} columns={[
              { key: 'plan', header: t('platform.plan'), cell: (p) => pick(p.name_ar, p.name_en) },
              { key: 'price', header: t('platform.subs.price'), cell: (p) => <span className="inline-flex items-center gap-1"><Money minor={p.price_monthly_minor} />{p.price_monthly_minor != null && p.price_is_test ? <TestBadge /> : null}</span> },
              { key: 'active', header: t('platform.sub_status.active'), cell: (p) => p.active },
              { key: 'trialing', header: t('platform.sub_status.trialing'), cell: (p) => p.trialing },
              { key: 'past_due', header: t('platform.sub_status.past_due'), cell: (p) => p.past_due },
            ]} />
          </Card>
        </>
      )}
      <Card title={t('platform.revenue.invoices')}>
        <Toolbar>
          <Select aria-label={t('fields.status')} className="w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">{t('platform.all_statuses')}</option>
            {['open', 'paid', 'void'].map((s) => <option key={s} value={s}>{t(`platform.invoice_status.${s}`)}</option>)}
          </Select>
        </Toolbar>
        {inv.isLoading ? <LoadingState /> : inv.error ? <ErrorState error={inv.error} /> : !inv.data!.items.length ? <EmptyState title={t('platform.revenue.no_invoices')} /> : (
          <>
            <DataTable rows={inv.data!.items} rowKey={(i) => i.id} caption={t('platform.revenue.invoices')} columns={[
              { key: 'n', header: '#', cell: (i) => <span className="font-mono text-xs" dir="ltr">{i.number}</span> },
              { key: 't', header: t('platform.business'), cell: (i) => i.tenant_name },
              { key: 'a', header: t('fields.total'), cell: (i) => <Money minor={i.amount_minor} currency={i.currency} /> },
              { key: 's', header: t('fields.status'), cell: (i) => <Badge tone={i.status === 'paid' ? 'ok' : i.status === 'open' ? 'warn' : 'neutral'}>{t(`platform.invoice_status.${i.status}`)}</Badge> },
              { key: 'd', header: t('platform.revenue.issued'), className: 'hidden md:table-cell', cell: (i) => <When v={i.issued_at} time={false} /> },
              { key: 'p', header: t('platform.revenue.paid_at'), className: 'hidden md:table-cell', cell: (i) => <When v={i.paid_at} time={false} /> },
            ]} />
            <PageNav page={page} total={inv.data!.total} limit={25} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
