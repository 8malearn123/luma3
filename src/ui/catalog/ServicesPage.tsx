'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ImageIcon, Plus, Search, Sparkles } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDuration } from '@/shared/format';
import { useApiQuery, useDebounced } from '../hooks';
import { Button } from '../components/button';
import { Checkbox, Input, Select } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { DataTable, PageHeader, Tabs, type Column } from '../components/layout';
import { useAccess } from '../shell/access-context';
import { qs, useFmt } from '../commerce/common';
import { CategoriesPanel, type Category } from './CategoriesPanel';
import { ServiceDrawer } from './ServiceDrawer';
import { PackagesTab } from './PackagesTab';
import { ResourcesTab } from './ResourcesTab';
import { ProposalsTab } from './ProposalsTab';

export type ServiceRow = {
  id: string; version: number; name_ar: string | null; name_en: string | null; description_ar: string | null; description_en: string | null;
  category_id: string | null; branch_id: string | null; price_minor: number; price_display: 'fixed' | 'starting_from'; duration_min: number;
  buffer_before_min: number; buffer_after_min: number; image_asset_id: string | null; is_active: boolean; is_visible: boolean;
  bookable_internally_when_hidden: boolean; booking_mode: 'individual' | 'group'; min_notice_min: number | null; max_advance_days: number | null;
  requires_manual_approval: boolean; archived_at: string | null; cost_minor?: number | null;
  staff: Array<{ staff_id: string; price_override_minor: number | null; duration_override_min: number | null; display_name: string; is_active: boolean }>;
  variants: Array<{ id: string; name_ar: string | null; name_en: string | null; price_minor: number; duration_min: number; is_active: boolean }>;
  addons: Array<{ id: string; name_ar: string | null; name_en: string | null; price_minor: number; duration_min: number; is_active: boolean }>;
  resources: Array<{ resource_type_id: string; quantity: number }>;
};

const TABS = ['services', 'packages', 'resources', 'proposals'] as const;
type Tab = (typeof TABS)[number];

export function ServicesPage() {
  const { t, pick, locale } = useI18n();
  const access = useAccess();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { money } = useFmt();
  const tab: Tab = (TABS as readonly string[]).includes(sp.get('tab') ?? '') ? (sp.get('tab') as Tab) : 'services';
  const open = sp.get('service');
  const setParams = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) u.set(k, v); else u.delete(k); }
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  };

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [archived, setArchived] = useState(false);
  const q = useDebounced(search.trim(), 300);
  const query = qs({ q, category_id: category, include_archived: archived ? '1' : '' });
  const list = useApiQuery<ServiceRow[]>(['services', access.slug, query], tab === 'services' ? access.api(`/services${query}`) : null);
  const cats = useApiQuery<Category[]>(['categories', access.slug, 'service'], access.api('/categories?kind=service'));
  const pending = useApiQuery<Array<{ id: string }>>(['price-proposals', access.slug, 'proposed'], access.api('/price-proposals?status=proposed'));
  const canEdit = access.can('catalog.edit') && !access.readOnly;
  const limit = access.plan.features['limit.services']?.limit as number | null | undefined;
  const filtered = !!(q || category);
  const catName = (id: string | null) => {
    const c = cats.data?.find((x) => x.id === id);
    return c ? pick(c.name_ar, c.name_en) : '';
  };

  const columns: Column<ServiceRow>[] = [
    {
      key: 'name', header: t('catalog_team.services.col_service'), cell: (r) => (
        <div className="flex items-center gap-3">
          {r.image_asset_id
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={`/api/v1/media/${r.image_asset_id}`} alt="" className="size-10 shrink-0 rounded-lg border border-line object-cover" />
            : <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-luma-50"><ImageIcon className="size-4 text-luma-300" aria-hidden /></span>}
          <div className="min-w-0">
            <p className="truncate font-medium">{pick(r.name_ar, r.name_en)}</p>
            <p className="truncate text-xs text-ink-muted">{[catName(r.category_id), formatDuration(r.duration_min, locale)].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'price', header: t('fields.price'), cell: (r) => (
        <span className="whitespace-nowrap">{r.price_display === 'starting_from' ? <span className="text-xs text-ink-muted">{t('catalog_ui.starting_from')} </span> : null}<span dir="ltr">{money(r.price_minor)}</span></span>
      ),
    },
    { key: 'staff', header: t('catalog_team.services.col_staff'), className: 'hidden sm:table-cell', cell: (r) => r.staff.length || '—' },
    {
      key: 'status', header: t('fields.status'), cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.archived_at ? <Badge tone="danger">{t('catalog_ui.archived')}</Badge>
            : <Badge tone={r.is_active ? 'ok' : 'neutral'}>{r.is_active ? t('fields.active') : t('fields.inactive')}</Badge>}
          {!r.is_visible && !r.archived_at ? <Badge>{t('fields.hidden')}</Badge> : null}
          {r.requires_manual_approval ? <Badge tone="info">{t('catalog_team.services.needs_approval')}</Badge> : null}
          {r.booking_mode === 'group' ? <Badge tone="brand">{t('catalog_ui.group')}</Badge> : null}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title={t('catalog_ui.services_title')} subtitle={t('catalog_team.services.subtitle')}
        actions={tab === 'services' && canEdit ? <Button icon={<Plus className="size-4" />} onClick={() => setParams({ service: 'new' })}>{t('catalog_ui.new_service')}</Button> : null} />
      <Tabs value={tab} onChange={(v) => setParams({ tab: v === 'services' ? null : v, service: null })} items={[
        { value: 'services', label: t('catalog_ui.services_title') },
        { value: 'packages', label: t('catalog_ui.packages') },
        { value: 'resources', label: t('catalog_team.resources.tab') },
        { value: 'proposals', label: t('catalog_ui.proposals'), count: pending.data?.length || undefined },
      ]} />

      {tab === 'packages' ? <PackagesTab /> : tab === 'resources' ? <ResourcesTab /> : tab === 'proposals' ? <ProposalsTab /> : (
        <div className="flex flex-col gap-4">
          <CategoriesPanel categories={cats} canEdit={canEdit} />
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative sm:w-72">
              <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-muted" aria-hidden />
              <Input aria-label={t('actions.search')} placeholder={t('catalog_team.services.search')} className="ps-9" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select aria-label={t('fields.category')} className="sm:w-56" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('catalog_team.services.all_categories')}</option>
              {cats.data?.map((c) => <option key={c.id} value={c.id}>{pick(c.name_ar, c.name_en)}</option>)}
            </Select>
            <Checkbox label={t('catalog_team.services.show_archived')} checked={archived} onChange={setArchived} />
            {limit ? <span className="text-xs text-ink-muted sm:ms-auto">{t('catalog_team.services.limit_note', { limit })}</span> : null}
          </div>
          {list.isLoading ? <LoadingState rows={5} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
            <EmptyState icon={<Sparkles className="size-8" aria-hidden />} title={filtered ? t('catalog_team.services.no_results') : t('catalog_ui.no_services')}
              hint={filtered ? undefined : t('catalog_team.services.empty_hint')}
              action={!filtered && canEdit ? <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setParams({ service: 'new' })}>{t('catalog_ui.new_service')}</Button> : undefined} />
          ) : (
            <DataTable rows={list.data} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => setParams({ service: r.id })} caption={t('catalog_ui.services_title')} />
          )}
        </div>
      )}
      {open && tab === 'services' ? <ServiceDrawer key={open} serviceId={open} categories={cats.data ?? []} onClose={() => setParams({ service: null })} /> : null}
    </div>
  );
}
