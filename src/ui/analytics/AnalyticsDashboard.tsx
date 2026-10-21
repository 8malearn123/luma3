'use client';

import { useMemo, useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney, WEEKDAYS } from '@/shared/format';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, DeniedState, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, Input, Select } from '../components/form';
import { Card, DataTable, PageHeader, Stat, Tabs } from '../components/layout';
import { useToast } from '../components/toast';
import { BarList, Funnel, HeatTable, pct, Sparkline } from './charts';

type Tab = 'store' | 'demand' | 'occupancy' | 'team';
type Period = { preset: '7' | '30' | '90' | 'custom'; from?: string; to?: string };

function localDate(tz: string, offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function periodQuery(p: Period, tz: string) {
  if (p.preset === 'custom') return p.from && p.to ? `from=${p.from}&to=${p.to}` : '';
  const n = Number(p.preset);
  return `from=${localDate(tz, -(n - 1))}&to=${localDate(tz)}`;
}

export function AnalyticsDashboard({ initialTab }: { initialTab?: string }) {
  const { t } = useI18n();
  const access = useAccess();
  const canAnalytics = access.can('analytics.view');
  const tabs = useMemo(() => {
    const all: Array<{ value: Tab; label: string }> = [
      { value: 'store', label: t('analytics.tabs.store') }, { value: 'demand', label: t('analytics.tabs.demand') },
      { value: 'occupancy', label: t('analytics.tabs.occupancy') }, { value: 'team', label: t('analytics.tabs.team') },
    ];
    return canAnalytics ? all : all.filter((x) => x.value === 'team');
  }, [t, canAnalytics]);
  const [tab, setTab] = useState<Tab>(() => (tabs.some((x) => x.value === initialTab) ? initialTab as Tab : tabs[0]!.value));
  const [period, setPeriod] = useState<Period>({ preset: '30' });
  const [custom, setCustom] = useState({ from: '', to: '' });
  if (!canAnalytics && !access.staffProfileId) return <DeniedState />;

  const changeTab = (v: Tab) => {
    setTab(v);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', v);
    window.history.replaceState(null, '', u.toString());
  };
  const q = periodQuery(period, access.timezone);

  return (
    <div>
      <PageHeader title={t('analytics.title')} subtitle={t('analytics.subtitle')} />
      <Tabs value={tab} onChange={changeTab} items={tabs} />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label={t('analytics.period.label')} className="w-44">
          {(p) => (
            <Select {...p} value={period.preset} onChange={(e) => setPeriod({ preset: e.target.value as Period['preset'], from: custom.from, to: custom.to })}>
              <option value="7">{t('analytics.period.last7')}</option>
              <option value="30">{t('analytics.period.last30')}</option>
              <option value="90">{t('analytics.period.last90')}</option>
              <option value="custom">{t('analytics.period.custom')}</option>
            </Select>
          )}
        </Field>
        {period.preset === 'custom' ? (
          <>
            <Field label={t('analytics.period.from')} className="w-40">{(p) => <Input {...p} type="date" dir="ltr" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />}</Field>
            <Field label={t('analytics.period.to')} className="w-40">{(p) => <Input {...p} type="date" dir="ltr" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />}</Field>
            <Button variant="outline" disabled={!custom.from || !custom.to} onClick={() => setPeriod({ preset: 'custom', ...custom })}>{t('analytics.period.apply')}</Button>
          </>
        ) : null}
      </div>
      {tab === 'store' ? <StoreTab q={q} /> : tab === 'demand' ? <DemandTab q={q} /> : tab === 'occupancy' ? <OccupancyTab q={q} /> : <TeamTab q={q} />}
    </div>
  );
}

function PeriodNote({ period }: { period?: { from: string; to: string; timezone: string } }) {
  const { t } = useI18n();
  if (!period) return null;
  return <p className="mb-3 text-xs text-ink-muted" dir="auto">{t('analytics.period.range', { from: period.from, to: period.to, tz: period.timezone })}</p>;
}

function StoreTab({ q }: { q: string }) {
  const { t, locale, pick } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const r = useApiQuery<any>(['analytics', access.slug, 'summary', q], access.api(`/analytics/summary?${q}`));
  if (r.isLoading) return <LoadingState rows={5} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const tt = d.totals, prev = d.previous;
  const sessionsSeries = d.series.filter((s: any) => s.metric === 'sessions').map((s: any) => ({ x: s.day, y: s.value }));
  const refresh = async () => {
    setBusy(true);
    try { await api(access.api('/analytics/rollup'), { body: { days: 30 } }); await qc.invalidateQueries({ queryKey: ['analytics', access.slug, 'summary'] }); }
    catch (e) { toast({ tone: 'danger', text: msg(e) }); } finally { setBusy(false); }
  };
  const sourceLabel = (k: string) => (k === 'direct_or_unknown' ? t('analytics.store.unknown_source') : k);
  return (
    <div className="flex flex-col gap-4">
      <PeriodNote period={d.period} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label={t('analytics.store.sessions')} value={tt.sessions} hint={t('analytics.store.previous', { v: prev.totals.sessions })} />
        <Stat label={t('analytics.store.conversion_rate')} value={pct(d.rates.conversion_rate, 1)} hint={t('analytics.store.previous', { v: pct(prev.rates.conversion_rate, 1) })} />
        <Stat label={t('analytics.store.bookings_per_session')} value={d.rates.bookings_per_session === null ? '—' : d.rates.bookings_per_session.toFixed(2)} />
        <Stat label={t('analytics.store.bookings')} value={tt.bookings_confirmed} hint={t('analytics.store.previous', { v: prev.totals.bookings_confirmed })} />
        <Stat label={t('analytics.store.orders')} value={tt.orders_paid} hint={t('analytics.store.previous', { v: prev.totals.orders_paid })} />
      </div>
      {tt.sessions === 0 ? <EmptyState title={t('analytics.store.empty')} /> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('analytics.store.funnel')}>
          <Funnel label={t('analytics.store.funnel')} steps={[
            { key: 'pv', label: t('analytics.store.page_views'), value: tt.page_views },
            { key: 'sv', label: t('analytics.store.service_views'), value: tt.service_views },
            { key: 'bs', label: t('analytics.store.booking_starts'), value: tt.booking_starts },
            { key: 'bc', label: t('analytics.store.bookings'), value: tt.session_bookings },
          ]} />
        </Card>
        <Card title={t('analytics.store.sources')}>
          <BarList label={t('analytics.store.sources')} empty={t('states.none')} items={d.sources.map((s: any) => ({ key: s.key, label: <span dir="ltr">{sourceLabel(s.key)}</span>, value: s.sessions }))} />
        </Card>
        <Card title={t('analytics.store.devices')}>
          <BarList label={t('analytics.store.devices')} empty={t('states.none')} items={d.devices.map((s: any) => ({ key: s.key, label: t(`analytics.store.device.${s.key}`), value: s.sessions }))} />
        </Card>
      </div>
      <Card title={t('analytics.store.series')} actions={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} loading={busy} onClick={refresh}>{t('analytics.store.refresh_series')}</Button>}>
        {sessionsSeries.length >= 2 ? <Sparkline points={sessionsSeries} label={t('analytics.store.series')} /> : <p className="text-sm text-ink-muted">{t('analytics.store.series_empty')}</p>}
        {d.series_computed_at ? <p className="mt-1 text-xs text-ink-muted">{t('analytics.store.series_updated', { time: formatDateTime(d.series_computed_at, { locale, tz: access.timezone }) })}</p> : null}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('analytics.store.top_services')}>
          {d.top_services.length ? (
            <DataTable rows={d.top_services} rowKey={(r: any) => r.service_id} caption={t('analytics.store.top_services')} columns={[
              { key: 'n', header: t('analytics.demand.service'), cell: (r: any) => pick(r.name_ar, r.name_en) },
              { key: 'v', header: t('analytics.store.views'), cell: (r: any) => r.views },
              { key: 's', header: t('analytics.store.starts'), cell: (r: any) => r.booking_starts },
              { key: 'c', header: t('analytics.store.confirmed'), cell: (r: any) => r.confirmed },
              { key: 'd', header: t('analytics.store.completed'), cell: (r: any) => r.completed },
            ]} />
          ) : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
        </Card>
        <Card title={t('analytics.store.top_products')}>
          {d.top_products.length ? (
            <DataTable rows={d.top_products} rowKey={(r: any) => r.product_id} caption={t('analytics.store.top_products')} columns={[
              { key: 'n', header: t('fields.name'), cell: (r: any) => pick(r.name_ar, r.name_en) },
              { key: 'v', header: t('analytics.store.views'), cell: (r: any) => r.views },
              { key: 'u', header: t('analytics.store.units'), cell: (r: any) => r.units_paid },
            ]} />
          ) : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
        </Card>
        <RecentList title={t('analytics.store.recent_bookings')} rows={d.recent_bookings} />
        <RecentList title={t('analytics.store.recent_orders')} rows={d.recent_orders} />
      </div>
      <Card title={t('analytics.store.definitions')}>
        <ul className="flex flex-col gap-1 text-sm text-ink-muted">
          <li>{t('analytics.store.def_session')}</li><li>{t('analytics.store.def_conversion')}</li><li>{t('analytics.store.def_bps')}</li>
        </ul>
        {d.excluded.length ? (
          <div className="mt-3">
            <p className="text-sm font-medium">{t('analytics.store.excluded')}</p>
            <div className="mt-1 flex flex-wrap gap-2">{d.excluded.map((e: any) => <Badge key={e.reason}>{t(`analytics.store.excluded_reason.${e.reason}`)}: {e.n}</Badge>)}</div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function RecentList({ title, rows }: { title: string; rows: any[] }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  return (
    <Card title={title}>
      {rows.length ? (
        <ul className="divide-y divide-line text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="font-mono text-xs" dir="ltr">{r.number}</span>
              <Badge>{r.status}</Badge>
              <span className="text-xs text-ink-muted">{formatDateTime(r.created_at, { locale, tz: access.timezone })}</span>
              <span className="tabular-nums">{r.total_minor === null ? t('analytics.store.amount_hidden') : formatMoney(r.total_minor, r.currency, locale)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
    </Card>
  );
}

function DemandTab({ q }: { q: string }) {
  const { t, locale, pick } = useI18n();
  const access = useAccess();
  const r = useApiQuery<any>(['analytics', access.slug, 'demand', q], access.api(`/analytics/demand?${q}`));
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  return (
    <div className="flex flex-col gap-3">
      <PeriodNote period={d.period} />
      <Alert tone="info">{t('analytics.demand.note')}</Alert>
      {d.services.length ? (
        <DataTable rows={d.services} rowKey={(x: any) => x.service_id} caption={t('analytics.tabs.demand')} columns={[
          { key: 'n', header: t('analytics.demand.service'), cell: (x: any) => pick(x.name_ar, x.name_en) },
          { key: 'p', header: t('analytics.demand.price'), cell: (x: any) => formatMoney(x.price_minor, access.currency, locale) },
          ...(d.services[0] && 'cost_minor' in d.services[0] ? [{ key: 'cost', header: t('analytics.demand.cost'), cell: (x: any) => (x.cost_minor === null ? t('states.unknown') : formatMoney(x.cost_minor, access.currency, locale)) }] : []),
          { key: 'v', header: t('analytics.demand.views'), cell: (x: any) => x.views },
          { key: 'b', header: t('analytics.demand.booking_starts'), cell: (x: any) => x.booking_starts },
          { key: 'e', header: t('analytics.demand.availability_empty'), cell: (x: any) => x.availability_empty },
          { key: 'w', header: t('analytics.demand.waitlist'), cell: (x: any) => x.waitlist_entries + x.waitlist_events },
          { key: 'c', header: t('analytics.demand.confirmed'), cell: (x: any) => x.confirmed },
          { key: 'd', header: t('analytics.demand.completed'), cell: (x: any) => x.completed },
          { key: 'x', header: t('analytics.demand.cancelled'), cell: (x: any) => x.cancelled },
          { key: 'ns', header: t('analytics.demand.no_show'), cell: (x: any) => x.no_show },
        ]} />
      ) : <EmptyState />}
    </div>
  );
}

function OccupancyTab({ q }: { q: string }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const r = useApiQuery<any>(['analytics', access.slug, 'occupancy', q], access.api(`/analytics/occupancy?${q}`));
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const h = (m: number) => t('analytics.occupancy.hours', { h: (m / 60).toFixed(1) });
  return (
    <div className="flex flex-col gap-4">
      <PeriodNote period={{ from: d.from, to: d.to, timezone: d.timezone }} />
      <Alert tone="info">{t('analytics.occupancy.formula')}</Alert>
      {d.totals.available_min === 0 ? <EmptyState title={t('analytics.occupancy.empty')} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('analytics.occupancy.total')} value={pct(d.totals.occupancy)} />
            <Stat label={t('analytics.occupancy.available')} value={h(d.totals.available_min)} />
            <Stat label={t('analytics.occupancy.booked')} value={h(d.totals.booked_min)} />
            <Stat label={t('analytics.occupancy.outside')} value={h(d.totals.booked_outside_min)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t('analytics.occupancy.staff')}>
              <BarList label={t('analytics.occupancy.staff')} format={(v) => `${Math.round(v * 100)}%`}
                items={d.staff.filter((s: any) => s.available_min > 0).map((s: any) => ({ key: s.staff_id, label: s.display_name, value: s.occupancy ?? 0, hint: `${h(s.booked_min)} / ${h(s.available_min)}` }))} />
            </Card>
            <Card title={t('analytics.occupancy.heatmap')}>
              <HeatTable caption={t('analytics.occupancy.heatmap')}
                rows={[0, 1, 2, 3, 4, 5, 6].map((w) => ({ key: String(w), label: WEEKDAYS[locale][w] }))}
                cols={['morning', 'afternoon', 'evening'].map((c) => ({ key: c, label: t(`analytics.occupancy.${c}`) }))}
                cell={(r2, c) => d.buckets.find((b: any) => String(b.weekday) === r2 && b.daypart === c)?.occupancy ?? null} />
            </Card>
          </div>
          <p className="text-xs text-ink-muted">{t('analytics.occupancy.staffing_note')}</p>
        </>
      )}
    </div>
  );
}

const IND_KEYS = ['satisfaction', 'review_count', 'repeat_rate', 'punctuality', 'avg_start_delay_min', 'execution_ratio', 'complaint_rate', 'occupancy', 'completed_per_available_hour'] as const;
const RATIO = new Set(['repeat_rate', 'punctuality', 'complaint_rate', 'occupancy']);

function fmtInd(key: string, v: number) {
  if (RATIO.has(key)) return `${Math.round(v * 100)}%`;
  if (key === 'satisfaction') return v.toFixed(2);
  if (key === 'review_count') return String(v);
  return v.toFixed(2);
}

function TeamTab({ q }: { q: string }) {
  const { t, locale, pick } = useI18n();
  const access = useAccess();
  const r = useApiQuery<any>(['analytics', access.slug, 'team', q], access.api(`/analytics/team?${q}`));
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  return (
    <div className="flex flex-col gap-4">
      <PeriodNote period={d.period} />
      <Alert tone="info">{t('analytics.team.note_usage')}</Alert>
      {d.scope === 'self' ? <p className="text-sm text-ink-muted">{t('analytics.team.self_only')}</p> : null}
      {!d.staff.length ? <EmptyState /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {d.staff.map((s: any) => (
          <Card key={s.staff_id} title={s.display_name} actions={<Badge>{t('analytics.team.specialty')}: {s.specialty ? pick(s.specialty.name_ar, s.specialty.name_en) : t('analytics.team.no_specialty')}</Badge>}>
            <div className="mb-3 flex flex-wrap gap-2 text-xs text-ink-muted">
              {Object.entries(s.counts).map(([k, v]) => <span key={k}>{t(`analytics.team.counts.${k}`)}: {String(v)}</span>)}
            </div>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {IND_KEYS.map((k) => {
                const ind = s.indicators[k];
                return (
                  <div key={k} className="rounded-lg border border-line p-2">
                    <dt className="text-xs text-ink-muted">{t(`analytics.team.indicators.${k}`)}</dt>
                    <dd className="text-sm font-semibold">{ind.status === 'ok' ? fmtInd(k, ind.value) : <span className="font-normal text-warn">{t('analytics.team.insufficient')}</span>}</dd>
                    {k !== 'review_count' ? <dd className="text-[11px] text-ink-muted">{t('analytics.team.n_of', { n: ind.n, min: ind.min_n })}</dd> : null}
                    {ind.interval ? <dd className="text-[11px] text-ink-muted" dir="ltr">{t('analytics.team.interval', { lo: fmtInd(k, ind.interval[0]), hi: fmtInd(k, ind.interval[1]) })}</dd> : null}
                  </div>
                );
              })}
            </dl>
            {s.execution.timed_services > 0 && s.execution.avg_actual_min !== null ? (
              <p className="mt-2 text-xs text-ink-muted">{t('analytics.team.actual_vs_planned', { a: Math.round(s.execution.avg_actual_min), p: Math.round(s.execution.avg_planned_min), n: s.execution.timed_services })}</p>
            ) : null}
            <p className="mt-2 text-xs text-ink-muted">{s.productivity_vs_specialty.index ? t('analytics.team.productivity_vs', { x: s.productivity_vs_specialty.index.toFixed(2) }) : t('analytics.team.not_enough_peers')}</p>
            <div className="mt-3 rounded-lg bg-luma-50 p-3">
              <p className="text-sm font-medium">{t('analytics.team.composite')}: {s.composite.status === 'ok' ? `${s.composite.score}/100` : t('analytics.team.insufficient')}</p>
              {s.composite.status !== 'ok' ? <p className="text-xs text-ink-muted">{t('analytics.team.composite_insufficient')}</p> : null}
              {s.composite.components.length ? <p className="mt-1 text-xs text-ink-muted">{s.composite.components.map((c: any) => `${t(`analytics.team.weight_keys.${c.key}`)} ${c.score} × ${c.weight}`).join(' • ')}</p> : null}
            </div>
          </Card>
        ))}
      </div>
      <Card title={t('analytics.team.method')}>
        <p className="text-sm text-ink-muted">{t('analytics.team.correction')}</p>
        <p className="mt-1 text-xs text-ink-muted">{t('analytics.period.range', { from: d.period.from, to: d.period.to, tz: d.period.timezone })}</p>
      </Card>
      {d.scope === 'team' ? <TeamSettings settings={d.settings} /> : null}
      {d.scope === 'team' && access.role !== 'specialist' ? <TeamInsights staff={d.staff} locale={locale} /> : null}
    </div>
  );
}

function TeamSettings({ settings }: { settings: any }) {
  const { t } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const [s, setS] = useState(settings);
  const [busy, setBusy] = useState(false);
  if (!access.can('business.manage', 'team.manage')) return null;
  const save = async () => {
    setBusy(true);
    try {
      await api(access.api('/analytics/team/settings'), { method: 'PUT', body: s });
      toast({ tone: 'ok', text: t('analytics.team.saved') });
      await qc.invalidateQueries({ queryKey: ['analytics', access.slug, 'team'] });
    } catch (e) { toast({ tone: 'danger', text: msg(e) }); } finally { setBusy(false); }
  };
  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));
  return (
    <Card title={t('analytics.team.settings_title')}>
      <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <legend className="mb-2 text-sm font-medium">{t('analytics.team.weights')}</legend>
        {(['satisfaction', 'repeat', 'punctuality', 'complaints', 'occupancy'] as const).map((k) => (
          <Field key={k} label={t(`analytics.team.weight_keys.${k}`)}>{(p) => <Input {...p} type="number" min={0} max={100} dir="ltr" value={s.weights[k]} onChange={(e) => setS({ ...s, weights: { ...s.weights, [k]: num(e.target.value) } })} />}</Field>
        ))}
      </fieldset>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={t('analytics.team.min_completed')}>{(p) => <Input {...p} type="number" min={5} dir="ltr" value={s.min_completed} onChange={(e) => setS({ ...s, min_completed: num(e.target.value) })} />}</Field>
        <Field label={t('analytics.team.min_reviews')}>{(p) => <Input {...p} type="number" min={3} dir="ltr" value={s.min_reviews} onChange={(e) => setS({ ...s, min_reviews: num(e.target.value) })} />}</Field>
        <Field label={t('analytics.team.min_timed')}>{(p) => <Input {...p} type="number" min={3} dir="ltr" value={s.min_timed} onChange={(e) => setS({ ...s, min_timed: num(e.target.value) })} />}</Field>
        <Field label={t('analytics.team.grace')}>{(p) => <Input {...p} type="number" min={0} max={60} dir="ltr" value={s.punctuality_grace_min} onChange={(e) => setS({ ...s, punctuality_grace_min: num(e.target.value) })} />}</Field>
      </div>
      <div className="mt-3 flex justify-end"><Button loading={busy} onClick={save}>{t('actions.save')}</Button></div>
    </Card>
  );
}

function TeamInsights({ staff, locale }: { staff: any[]; locale: 'ar' | 'en' }) {
  const { t } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const enabled = access.hasFeature('feature.marketing_ai');
  const r = useApiQuery<any>(['analytics', access.slug, 'insights'], enabled ? access.api('/analytics/team/insights') : null, { refetchInterval: 15000 });
  if (!enabled) return null;
  // `data: null` (no reading yet) comes back as the bare envelope.
  const job = r.data && typeof r.data.status === 'string' ? r.data : null;
  const request = async () => {
    setBusy(true);
    try { await api(access.api('/analytics/team/insights'), { body: {} }); await r.refetch(); }
    catch (e) { toast({ tone: 'danger', text: msg(e) }); } finally { setBusy(false); }
  };
  const nameOf = (id: string) => staff.find((s) => s.staff_id === id)?.display_name ?? '—';
  return (
    <Card title={t('analytics.team.insights_title')} actions={<Button size="sm" variant="outline" loading={busy} onClick={request}>{t('analytics.team.insights_request')}</Button>}>
      {!job ? <p className="text-sm text-ink-muted">{t('analytics.team.insights_none')}</p>
        : job.status === 'unavailable' || job.status === 'failed' ? <Alert tone="warn">{t('analytics.team.insights_unavailable', { reason: t(`marketing.job_errors.${job.error_code ?? 'internal_error'}`) })}</Alert>
          : job.status !== 'succeeded' ? <p className="text-sm text-ink-muted"><Info className="me-1 inline size-4" />{t(`marketing.job_status.${job.status}`)}</p>
            : (
              <ul className="flex flex-col gap-3 text-sm">
                {(job.result_ref?.insights ?? []).map((x: any) => (
                  <li key={x.staff_id} className="rounded-lg border border-line p-3">
                    <p className="font-medium">{nameOf(x.staff_id)}</p>
                    <p className="text-ink-muted" dir="auto">{x.explanation}</p>
                    <ul className="mt-1 list-disc ps-5">{x.development_suggestions.map((s: string, i: number) => <li key={i} dir="auto">{s}</li>)}</ul>
                  </li>
                ))}
                <li className="text-xs text-ink-muted">{t('analytics.team.insights_note')} {job.finished_at ? formatDateTime(job.finished_at, { locale, tz: access.timezone }) : ''}</li>
              </ul>
            )}
    </Card>
  );
}
