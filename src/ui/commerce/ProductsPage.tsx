'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ImageIcon, Plus, Search, ShoppingBag } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery, useDebounced } from '../hooks';
import { Button } from '../components/button';
import { Input, Select } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { DataTable, PageHeader, Tabs, type Column } from '../components/layout';
import { useAccess } from '../shell/access-context';
import { OffsetPager, qs, StockBadge, useFmt } from './common';
import { ProductDrawer } from './ProductDrawer';
import { CouponsTab } from './CouponsTab';

type Row = {
  id: string; name_ar: string | null; name_en: string | null; status: string; is_visible: boolean; hide_when_out_of_stock: boolean;
  price_minor: number | null; sku: string | null; available: number; low_stock: boolean; variant_count: number; image_asset_id: string | null;
  category_name_ar: string | null; category_name_en: string | null;
};
const LIMIT = 25;

export function ProductsPage() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab = sp.get('tab') === 'coupons' && access.can('catalog.edit') ? 'coupons' : 'products';
  const open = sp.get('product');
  const setParam = (k: string, v: string | null) => {
    const u = new URLSearchParams(sp.toString());
    if (v) u.set(k, v); else u.delete(k);
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  };

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [stock, setStock] = useState('');
  const [sort, setSort] = useState('created');
  const [offset, setOffset] = useState(0);
  const q = useDebounced(search.trim(), 300);
  const query = qs({ q, status, stock, sort, dir: sort === 'name' || sort === 'stock' ? 'asc' : 'desc', limit: LIMIT, offset });
  const list = useApiQuery<{ items: Row[]; total: number }>(['products', access.slug, query], tab === 'products' ? access.api(`/products${query}`) : null);
  const { money } = useFmt();
  const limit = access.plan.features['limit.products']?.limit as number | null | undefined;
  const filtered = !!(q || status || stock);

  const columns: Column<Row>[] = [
    {
      key: 'name', header: t('commerce.products.col_product'), cell: (r) => (
        <div className="flex items-center gap-3">
          {r.image_asset_id
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={`/api/v1/media/${r.image_asset_id}`} alt="" className="size-10 rounded-lg border border-line object-cover" />
            : <span className="flex size-10 items-center justify-center rounded-lg bg-luma-50"><ImageIcon className="size-4 text-luma-300" aria-hidden /></span>}
          <div className="min-w-0">
            <p className="truncate font-medium">{pick(r.name_ar, r.name_en)}</p>
            <p className="truncate text-xs text-ink-muted">{[pick(r.category_name_ar, r.category_name_en), r.sku].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
      ),
    },
    { key: 'price', header: t('commerce.products.col_price'), cell: (r) => <span dir="ltr">{money(r.price_minor)}</span> },
    { key: 'stock', header: t('commerce.products.col_stock'), cell: (r) => <span className="inline-flex items-center gap-2">{r.available}<StockBadge available={r.available} low={r.low_stock} /></span> },
    {
      key: 'status', header: t('commerce.products.col_status'), cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={r.status === 'active' ? 'ok' : 'neutral'}>{t(`commerce.products.status.${r.status}`)}</Badge>
          {!r.is_visible ? <Badge>{t('commerce.products.hidden')}</Badge> : null}
          {r.hide_when_out_of_stock && r.available <= 0 ? <Badge tone="warn">{t('commerce.products.hidden_when_out')}</Badge> : null}
        </span>
      ),
    },
    { key: 'variants', header: t('commerce.products.col_variants'), className: 'hidden sm:table-cell', cell: (r) => r.variant_count },
  ];

  return (
    <div>
      <PageHeader title={t('commerce.products.title')} subtitle={t('commerce.products.subtitle')}
        actions={tab === 'products' && access.can('catalog.edit') && !access.readOnly ? <Button icon={<Plus className="size-4" />} onClick={() => setParam('product', 'new')}>{t('commerce.products.new')}</Button> : null} />
      {access.can('catalog.edit') ? (
        <Tabs value={tab} onChange={(v) => setParam('tab', v === 'coupons' ? 'coupons' : null)}
          items={[{ value: 'products', label: t('commerce.products.tab_products') }, { value: 'coupons', label: t('commerce.products.tab_coupons') }]} />
      ) : null}

      {tab === 'coupons' ? <CouponsTab /> : (
        <>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative sm:w-72">
              <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-muted" aria-hidden />
              <Input aria-label={t('actions.search')} placeholder={t('commerce.products.search')} className="ps-9" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
            </div>
            <Select aria-label={t('commerce.products.filter_status')} className="sm:w-48" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
              <option value="">{t('commerce.products.all_statuses')}</option>
              <option value="active">{t('commerce.products.status.active')}</option>
              <option value="draft">{t('commerce.products.status.draft')}</option>
              <option value="archived">{t('commerce.products.status.archived')}</option>
              <option value="all">{t('commerce.products.all_with_archived')}</option>
            </Select>
            <Select aria-label={t('commerce.products.filter_stock')} className="sm:w-40" value={stock} onChange={(e) => { setStock(e.target.value); setOffset(0); }}>
              <option value="">{t('commerce.products.stock_any')}</option>
              <option value="in">{t('commerce.products.stock_in')}</option>
              <option value="low">{t('commerce.products.stock_low')}</option>
              <option value="out">{t('commerce.products.stock_out')}</option>
            </Select>
            <Select aria-label={t('commerce.products.sort')} className="sm:w-40" value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); }}>
              <option value="created">{t('commerce.products.sort_created')}</option>
              <option value="name">{t('commerce.products.sort_name')}</option>
              <option value="price">{t('commerce.products.sort_price')}</option>
              <option value="stock">{t('commerce.products.sort_stock')}</option>
            </Select>
            {limit ? <span className="text-xs text-ink-muted sm:ms-auto">{t('commerce.products.limit_note', { limit })}</span> : null}
          </div>
          {list.isLoading ? <LoadingState rows={5} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.items.length ? (
            <EmptyState icon={<ShoppingBag className="size-8" aria-hidden />} title={filtered ? t('commerce.products.no_results') : t('commerce.products.empty')}
              hint={filtered ? undefined : t('commerce.products.empty_hint')}
              action={!filtered && access.can('catalog.edit') && !access.readOnly ? <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setParam('product', 'new')}>{t('commerce.products.new')}</Button> : undefined} />
          ) : (
            <>
              <DataTable rows={list.data.items} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => setParam('product', r.id)} caption={t('commerce.products.title')} />
              <OffsetPager offset={offset} limit={LIMIT} total={list.data.total} onChange={setOffset} />
            </>
          )}
        </>
      )}
      {open && tab === 'products' ? <ProductDrawer key={open} productId={open as string} onClose={() => setParam('product', null)} /> : null}
    </div>
  );
}
