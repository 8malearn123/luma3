'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { LocateFixed, Search, SlidersHorizontal, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery, useDebounced } from '../hooks';
import { Button } from '../components/button';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Input, Select } from '../components/form';
import { Pager } from '../components/layout';
import { cx } from '../components/cx';
import { BusinessCard, type MarketCardData } from './BusinessCard';

type Facets = { cities: Array<{ name: string; count: number }>; specialties: Array<{ key: string; name_ar: string | null; name_en: string | null; count: number }>; price: { min: number | null; max: number | null } };
type Result = { items: MarketCardData[]; total: number; page: number; limit: number; facets: Facets };

const SORTS = ['best', 'nearest', 'top_rated', 'most_booked', 'price_asc', 'price_desc'] as const;
const LIMIT = 24;

/**
 * Marketplace search (filters + sorts). State lives in the URL so results can
 * be shared. "Nearest" asks the browser for a location once; coordinates are
 * rounded and only used to compute distances, never stored.
 */
export function MarketSearch({ door, signedIn }: { door?: 'salons' | 'experts'; signedIn: boolean }) {
  const { t, pick } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const get = (k: string) => sp.get(k) ?? '';
  const [q, setQ] = useState(get('q'));
  const dq = useDebounced(q, 350);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [geoState, setGeoState] = useState<'idle' | 'asking' | 'denied'>('idle');
  const [panel, setPanel] = useState(false);

  const set = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) u.set(k, v); else u.delete(k); }
    if (!('page' in patch)) u.delete('page');
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  };
  useEffect(() => { if (dq !== get('q')) set({ q: dq || null }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps

  const sort = (SORTS as readonly string[]).includes(get('sort')) ? get('sort') : 'best';
  const page = Math.max(1, Number(get('page')) || 1);
  const requestGeo = () => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) { setGeoState('denied'); return; }
    setGeoState('asking');
    navigator.geolocation.getCurrentPosition(
      (p) => { setGeo({ lat: Math.round(p.coords.latitude * 100) / 100, lng: Math.round(p.coords.longitude * 100) / 100 }); setGeoState('idle'); },
      () => setGeoState('denied'),
      { maximumAge: 600_000, timeout: 10_000 },
    );
  };

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (door) p.set('door', door);
    for (const k of ['q', 'type', 'specialty', 'city', 'min_rating', 'price_min', 'price_max']) if (get(k)) p.set(k, get(k));
    p.set('sort', sort); p.set('page', String(page)); p.set('limit', String(LIMIT));
    if (sort === 'nearest' && geo) { p.set('lat', String(geo.lat)); p.set('lng', String(geo.lng)); }
    return p.toString();
  }, [sp, door, sort, page, geo]); // eslint-disable-line react-hooks/exhaustive-deps
  const waitingGeo = sort === 'nearest' && geoState === 'asking';
  const res = useApiQuery<Result>(['market', 'search', params], waitingGeo ? null : `/api/v1/market/search?${params}`);
  const f = res.data?.facets;
  const active = ['type', 'specialty', 'city', 'min_rating', 'price_min', 'price_max'].filter((k) => get(k)).length;
  const sar = (v: string) => (v ? String(Math.round(Number(v) / 100)) : '');

  const filters = (
    <div className="flex flex-col gap-4">
      {!door ? (
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">{t('market.filters.type')}</span>
          <Select value={get('type')} onChange={(e) => set({ type: e.target.value || null })}>
            <option value="">{t('market.filters.all_types')}</option>
            {['salon', 'beauty_center', 'spa', 'expert'].map((x) => <option key={x} value={x}>{t(`market.types.${x}`)}</option>)}
          </Select>
        </label>
      ) : door === 'salons' ? (
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">{t('market.filters.type')}</span>
          <Select value={get('type')} onChange={(e) => set({ type: e.target.value || null })}>
            <option value="">{t('market.filters.all_salons')}</option>
            {['salon', 'beauty_center', 'spa'].map((x) => <option key={x} value={x}>{t(`market.types.${x}`)}</option>)}
          </Select>
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">{t('market.filters.specialty')}</span>
        <Select value={get('specialty')} onChange={(e) => set({ specialty: e.target.value || null })}>
          <option value="">{t('market.filters.all_specialties')}</option>
          {(f?.specialties ?? []).map((s) => <option key={s.key} value={s.key}>{pick(s.name_ar, s.name_en)} ({s.count})</option>)}
          {get('specialty') && !f?.specialties.some((s) => s.key === get('specialty')) ? <option value={get('specialty')}>{get('specialty')}</option> : null}
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">{t('market.filters.city')}</span>
        <Select value={get('city')} onChange={(e) => set({ city: e.target.value || null })}>
          <option value="">{t('market.filters.all_cities')}</option>
          {(f?.cities ?? []).map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
          {get('city') && !f?.cities.some((c) => c.name === get('city')) ? <option value={get('city')}>{get('city')}</option> : null}
        </Select>
      </label>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 font-medium">{t('market.filters.rating')}</legend>
        <div className="flex flex-wrap gap-1.5">
          {['', '3', '4', '4.5'].map((r) => (
            <button key={r || 'any'} type="button" onClick={() => set({ min_rating: r || null })} aria-pressed={get('min_rating') === r}
              className={cx('rounded-full border px-3 py-1 text-xs', get('min_rating') === r ? 'border-luma-700 bg-luma-700 text-white' : 'border-luma-200 bg-white hover:border-luma-500')}>
              {r ? t('market.filters.rating_min', { n: r }) : t('market.filters.any')}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="text-sm">
        <legend className="mb-1 font-medium">{t('market.filters.price')}</legend>
        <div className="flex items-center gap-2">
          <Input type="number" min={0} inputMode="numeric" dir="ltr" aria-label={t('market.filters.price_min')} placeholder={t('market.filters.price_min')} defaultValue={sar(get('price_min'))}
            onBlur={(e) => set({ price_min: e.target.value ? String(Math.round(Number(e.target.value) * 100)) : null })} />
          <span className="text-ink-muted">–</span>
          <Input type="number" min={0} inputMode="numeric" dir="ltr" aria-label={t('market.filters.price_max')} placeholder={t('market.filters.price_max')} defaultValue={sar(get('price_max'))}
            onBlur={(e) => set({ price_max: e.target.value ? String(Math.round(Number(e.target.value) * 100)) : null })} />
        </div>
        <p className="mt-1 text-xs text-ink-muted">{t('market.filters.price_hint')}</p>
      </fieldset>
      {active ? <Button variant="ghost" icon={<X className="size-4" />} onClick={() => set({ type: null, specialty: null, city: null, min_rating: null, price_min: null, price_max: null })}>{t('market.filters.clear')}</Button> : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-3xl border border-luma-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="sr-only">{t('market.search_label')}</span>
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('market.search_placeholder')} className="ps-9" maxLength={80} type="search" />
        </label>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm"><span className="shrink-0 text-ink-muted">{t('market.sort.label')}</span>
            <Select value={sort} onChange={(e) => { if (e.target.value === 'nearest' && !geo) requestGeo(); set({ sort: e.target.value === 'best' ? null : e.target.value }); }} className="w-auto">
              {SORTS.map((s) => <option key={s} value={s}>{t(`market.sort.${s}`)}</option>)}
            </Select>
          </label>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-luma-200 px-3 py-2 text-sm lg:hidden" onClick={() => setPanel((v) => !v)} aria-expanded={panel}>
            <SlidersHorizontal className="size-4" aria-hidden />{t('market.filters.title')}{active ? <span className="rounded-full bg-luma-700 px-1.5 text-[11px] text-white">{active}</span> : null}
          </button>
        </div>
      </div>
      {sort === 'nearest' && geoState === 'denied' ? <p className="rounded-xl bg-warn-bg px-3 py-2 text-sm text-warn" role="status"><LocateFixed className="me-1 inline size-4" aria-hidden />{t('market.geo_denied')}</p> : null}
      {sort === 'nearest' && !geo && geoState === 'idle' ? (
        <div><Button variant="outline" icon={<LocateFixed className="size-4" />} onClick={requestGeo}>{t('market.use_location')}</Button></div>
      ) : null}
      {sort === 'nearest' && geoState === 'asking' ? <p className="text-sm text-ink-muted" role="status">{t('market.geo_asking')}</p> : null}
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <aside className={cx('rounded-3xl border border-luma-200 bg-white p-4 lg:sticky lg:top-20 lg:block lg:w-64 lg:shrink-0', !panel && 'hidden')} aria-label={t('market.filters.title')}>
          <h2 className="mb-3 hidden font-semibold text-luma-900 lg:block">{t('market.filters.title')}</h2>
          {filters}
        </aside>
        <section className="min-w-0 flex-1" aria-live="polite">
          {res.isLoading || waitingGeo ? <LoadingState rows={4} /> : res.error ? <ErrorState error={res.error} onRetry={() => res.refetch()} /> : !res.data!.items.length ? (
            <EmptyState title={t('market.empty')} hint={t('market.empty_hint')} />
          ) : (
            <>
              <p className="mb-3 text-sm text-ink-muted">{t('market.results', { n: res.data!.total })}</p>
              <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {res.data!.items.map((c) => <li key={c.slug}><BusinessCard card={c} signedIn={signedIn} /></li>)}
              </ul>
              {res.data!.total > LIMIT ? (
                <div className="mt-6"><Pager hasPrev={page > 1} hasNext={page * LIMIT < res.data!.total} onPrev={() => set({ page: String(page - 1) })} onNext={() => set({ page: String(page + 1) })} /></div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
