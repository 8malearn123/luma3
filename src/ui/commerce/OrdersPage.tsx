'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Receipt, Search } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery, useDebounced } from '../hooks';
import { Input, Select } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { DataTable, PageHeader, Tabs, type Column } from '../components/layout';
import { useAccess } from '../shell/access-context';
import { OffsetPager, OrderStatusBadge, qs, useFmt } from './common';
import { OrderDrawer } from './OrderDrawer';

type Row = {
  id: string; number: string; status: string; refund_status: string; fulfillment_method: string; total_minor: number; created_at: string;
  customer_name: string; customer_phone: string | null; item_count: number;
};
const LIMIT = 25;
const TABS = ['open', 'pending_payment', 'paid', 'preparing', 'ready', 'collected', 'cancelled', 'all'] as const;

export function OrdersPage() {
  const { t } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const open = sp.get('order');
  const setOpen = (id: string | null) => {
    const u = new URLSearchParams(sp.toString());
    if (id) u.set('order', id); else u.delete('order');
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  };
  const [status, setStatus] = useState<(typeof TABS)[number]>('open');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('created');
  const [offset, setOffset] = useState(0);
  const q = useDebounced(search.trim(), 300);
  const query = qs({ status, q, sort, dir: sort === 'number' ? 'desc' : 'desc', limit: LIMIT, offset });
  const list = useApiQuery<{ items: Row[]; total: number; counts: Record<string, number> }>(['orders', access.slug, query], access.api(`/orders${query}`), { refetchInterval: 60_000 });
  const counts = list.data?.counts ?? {};
  const openCount = ['pending_payment', 'paid', 'preparing', 'ready'].reduce((a, s) => a + (counts[s] ?? 0), 0);

  const columns: Column<Row>[] = [
    { key: 'number', header: t('commerce.orders.col_number'), cell: (r) => <span dir="ltr" className="font-mono font-medium">{r.number}</span> },
    { key: 'customer', header: t('commerce.orders.col_customer'), cell: (r) => <div><p className="font-medium">{r.customer_name}</p>{r.customer_phone ? <p dir="ltr" className="text-xs text-ink-muted">{r.customer_phone}</p> : null}</div> },
    { key: 'items', header: t('commerce.orders.col_items'), className: 'hidden sm:table-cell', cell: (r) => r.item_count },
    { key: 'total', header: t('commerce.orders.col_total'), cell: (r) => <span dir="ltr">{money(r.total_minor)}</span> },
    {
      key: 'status', header: t('commerce.orders.col_status'), cell: (r) => (
        <span className="flex flex-wrap gap-1"><OrderStatusBadge status={r.status} />{r.refund_status !== 'none' ? <Badge tone="warn">{t(`commerce.orders.refund.${r.refund_status}`)}</Badge> : null}</span>
      ),
    },
    { key: 'date', header: t('commerce.orders.col_date'), className: 'hidden md:table-cell', cell: (r) => <span className="text-xs">{when(r.created_at)}</span> },
  ];

  return (
    <div>
      <PageHeader title={t('commerce.orders.title')} subtitle={t('commerce.orders.subtitle')} />
      <Tabs value={status} onChange={(v) => { setStatus(v); setOffset(0); }} items={TABS.map((s) => ({
        value: s,
        label: s === 'open' ? t('commerce.orders.filter_open') : s === 'all' ? t('commerce.orders.filter_all') : t(`commerce.orders.status.${s}`),
        count: s === 'open' ? openCount : s === 'all' ? undefined : counts[s],
      }))} />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <div className="relative sm:w-80">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-muted" aria-hidden />
          <Input aria-label={t('actions.search')} placeholder={t('commerce.orders.search')} className="ps-9" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
        </div>
        <Select aria-label={t('commerce.products.sort')} className="sm:w-44" value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); }}>
          <option value="created">{t('commerce.products.sort_created')}</option>
          <option value="total">{t('commerce.orders.col_total')}</option>
          <option value="number">{t('commerce.orders.col_number')}</option>
        </Select>
      </div>
      {list.isLoading ? <LoadingState rows={5} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.items.length ? (
        <EmptyState icon={<Receipt className="size-8" aria-hidden />} title={t('commerce.orders.empty')} hint={t('commerce.orders.empty_hint')} />
      ) : (
        <>
          <DataTable rows={list.data.items} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} caption={t('commerce.orders.title')} />
          <OffsetPager offset={offset} limit={LIMIT} total={list.data.total} onChange={setOffset} />
        </>
      )}
      {open ? <OrderDrawer key={open} orderId={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
