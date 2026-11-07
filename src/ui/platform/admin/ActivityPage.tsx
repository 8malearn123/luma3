'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { useApiQuery, useDebounced } from '../../hooks';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Input, Select } from '../../components/form';
import { Card, DataTable, PageHeader, Tabs } from '../../components/layout';
import { Money, PageNav, Toolbar, When, qs } from '../common';
import { CsvLink } from './period';
import { BOOKING_SOURCES, BOOKING_STATUSES, PAYMENT_PURPOSES, PAYMENT_STATUSES } from '@/shared/schemas/admin';

type BookingRow = { id: string; number: string; status: string; payment_status: string; source: string; starts_at: string; total_minor: number; paid_minor: number; currency: string; created_at: string; tenant_slug: string; tenant_name: string };
type PaymentRow = { id: string; purpose: string; method: string; amount_minor: number; currency: string; status: string; captured_at: string | null; created_at: string; tenant_slug: string; tenant_name: string; reference: string | null; refunded_minor: number };

export function ActivityPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'bookings' | 'payments'>('bookings');
  const [f, setF] = useState({ tenant: '', status: '', source: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const tenant = useDebounced(f.tenant.trim().toLowerCase(), 400);
  const filters = { tenant: /^[a-z0-9-]{3,48}$/.test(tenant) ? tenant : undefined, status: f.status, source: f.source, from: f.from, to: f.to };
  const base = `/api/v1/platform/activity/${tab}`;
  const path = `${base}${qs({ ...filters, page, limit: 25 })}`;
  const set = (p: Partial<typeof f>) => { setF({ ...f, ...p }); setPage(1); };
  const statuses = tab === 'bookings' ? BOOKING_STATUSES : PAYMENT_STATUSES;
  const sources = tab === 'bookings' ? BOOKING_SOURCES : PAYMENT_PURPOSES;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('admin.activity.title')} subtitle={t('admin.activity.subtitle')} actions={<CsvLink href={`${base}${qs({ ...filters, format: 'csv' })}`} />} />
      <Tabs value={tab} onChange={(v) => { setTab(v); setF({ ...f, status: '', source: '' }); setPage(1); }} items={[{ value: 'bookings', label: t('admin.activity.bookings') }, { value: 'payments', label: t('admin.activity.payments') }]} />
      <Toolbar>
        <Input aria-label={t('admin.tenant_slug')} placeholder={t('admin.tenant_slug')} dir="ltr" className="w-48" value={f.tenant} onChange={(e) => set({ tenant: e.target.value })} />
        <Select aria-label={t('admin.activity.status')} className="w-auto" value={f.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">{t('admin.activity.status')}: {t('admin.all')}</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Select aria-label={t('admin.activity.source')} className="w-auto" value={f.source} onChange={(e) => set({ source: e.target.value })}>
          <option value="">{t(tab === 'bookings' ? 'admin.activity.source' : 'admin.activity.purpose')}: {t('admin.all')}</option>
          {sources.map((s) => <option key={s} value={s}>{t(tab === 'bookings' ? `admin.activity.sources.${s}` : `admin.activity.purposes.${s}`)}</option>)}
        </Select>
        <Input type="date" aria-label={t('admin.period.from')} className="w-36" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        <Input type="date" aria-label={t('admin.period.to')} className="w-36" value={f.to} onChange={(e) => set({ to: e.target.value })} />
      </Toolbar>
      <Card>
        {tab === 'bookings' ? <BookingsTable path={path} page={page} setPage={setPage} /> : <PaymentsTable path={path} page={page} setPage={setPage} />}
      </Card>
    </div>
  );
}

const TenantCell = ({ slug, name }: { slug: string; name: string }) => <Link className="text-luma-700 hover:underline" href={`/platform/tenants?q=${encodeURIComponent(slug)}`}>{name}</Link>;

function BookingsTable({ path, page, setPage }: { path: string; page: number; setPage: (n: number) => void }) {
  const { t } = useI18n();
  const q = useApiQuery<{ items: BookingRow[]; total: number }>(['platform', 'activity', path], path);
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data!.items.length) return <EmptyState title={t('admin.none')} />;
  return (
    <>
      <DataTable rows={q.data!.items} rowKey={(r) => r.id} caption={t('admin.activity.bookings')} columns={[
        { key: 'n', header: t('admin.activity.number'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.number}</span> },
        { key: 't', header: t('admin.tenant'), cell: (r) => <TenantCell slug={r.tenant_slug} name={r.tenant_name} /> },
        { key: 's', header: t('admin.activity.status'), cell: (r) => <Badge>{r.status}</Badge> },
        { key: 'p', header: t('admin.activity.payment_status'), className: 'hidden md:table-cell', cell: (r) => r.payment_status },
        { key: 'src', header: t('admin.activity.source'), className: 'hidden sm:table-cell', cell: (r) => t(`admin.activity.sources.${r.source}`) },
        { key: 'at', header: t('admin.activity.starts'), className: 'hidden lg:table-cell', cell: (r) => <When v={r.starts_at} /> },
        { key: 'tot', header: t('admin.activity.total'), cell: (r) => <Money minor={r.total_minor} currency={r.currency} /> },
      ]} />
      <PageNav page={page} total={q.data!.total} limit={25} onPage={setPage} />
    </>
  );
}

function PaymentsTable({ path, page, setPage }: { path: string; page: number; setPage: (n: number) => void }) {
  const { t } = useI18n();
  const q = useApiQuery<{ items: PaymentRow[]; total: number; captured_minor: number }>(['platform', 'activity', path], path);
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data!.items.length) return <EmptyState title={t('admin.none')} />;
  return (
    <>
      <p className="mb-2 text-sm text-ink-muted">{t('admin.activity.captured')}: <Money minor={q.data!.captured_minor} /></p>
      <DataTable rows={q.data!.items} rowKey={(r) => r.id} caption={t('admin.activity.payments')} columns={[
        { key: 'ref', header: t('admin.activity.reference'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.reference ?? '—'}</span> },
        { key: 't', header: t('admin.tenant'), cell: (r) => <TenantCell slug={r.tenant_slug} name={r.tenant_name} /> },
        { key: 'pu', header: t('admin.activity.purpose'), className: 'hidden sm:table-cell', cell: (r) => t(`admin.activity.purposes.${r.purpose}`) },
        { key: 'm', header: t('admin.activity.method'), className: 'hidden md:table-cell', cell: (r) => r.method },
        { key: 's', header: t('admin.activity.status'), cell: (r) => <Badge tone={r.status === 'captured' ? 'ok' : r.status === 'failed' ? 'danger' : 'neutral'}>{r.status}</Badge> },
        { key: 'a', header: t('admin.activity.amount'), cell: (r) => <Money minor={r.amount_minor} currency={r.currency} /> },
        { key: 'c', header: t('admin.activity.created'), className: 'hidden lg:table-cell', cell: (r) => <When v={r.captured_at ?? r.created_at} /> },
      ]} />
      <PageNav page={page} total={q.data!.total} limit={25} onPage={setPage} />
    </>
  );
}
