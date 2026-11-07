'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Newspaper, RefreshCw, Settings } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDate, formatNumber, WEEKDAYS } from '@/shared/format';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Card, PageHeader, Stat } from '../components/layout';
import { Alert, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, Select } from '../components/form';
import { useToast } from '../components/toast';
import { useFmt } from '../commerce/common';
import { BarList } from '../analytics/charts';
import { DayColumns } from './BusinessOverview';

type DigestPayload = {
  period: { period_start: string; period_end: string };
  bookings: { bookings: number; completed: number; cancelled: number; no_show: number; new_bookings: number; previous: { bookings: number; completed: number; new_bookings: number } };
  revenue: { completed_value_minor: number; collections_minor: number; previous_collections_minor: number; previous_completed_value_minor: number } | null;
  top_services: Array<{ service_id: string; name_ar: string | null; name_en: string | null; bookings: number; value_minor: number | null }>;
  staff: Array<{ staff_id: string; name: string; completed: number; no_show: number; value_minor: number | null; rating: number | null; reviews: number }>;
  low_stock: Array<{ id: string; name: string; unit: string; available: number; threshold: number }>;
  upcoming: { from: string; to: string; days: Array<{ date: string; bookings: number }>; bookings: number; expected_value_minor: number | null };
};
type Digest = { id: string; period_start: string; period_end: string; created_at: string; delivered_channels: string[]; money: boolean; payload: DigestPayload };
type DigestRow = { id: string; period_start: string; period_end: string; created_at: string; delivered_channels: string[] };

function useRange() {
  const { locale } = useI18n();
  return (a: string, b: string) => `${formatDate(`${a}T12:00:00Z`, { tz: 'UTC', locale })} – ${formatDate(`${b}T12:00:00Z`, { tz: 'UTC', locale })}`;
}

export function DigestList() {
  const { t } = useI18n();
  const access = useAccess();
  const router = useRouter();
  const msg = useErrorMessage();
  const range = useRange();
  const q = useApiQuery<DigestRow[]>(['digests', access.slug], access.api('/digests'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const canManage = access.can('business.manage') && !access.readOnly;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('business.digest.title')} subtitle={t('business.digest.subtitle')} actions={<>
        {access.can('business.manage') ? <Link href={`/app/${access.slug}/settings?tab=digest`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm hover:bg-luma-50"><Settings className="size-4" aria-hidden />{t('business.digest.schedule')}</Link> : null}
        {canManage ? <Button icon={<RefreshCw className="size-4" />} loading={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { const r = await api<{ id: string }>(access.api('/digests'), { method: 'POST' }); router.push(`/app/${access.slug}/digest/${r.id}`); }
          catch (e) { setErr(e); } finally { setBusy(false); }
        }}>{t('business.digest.generate_now')}</Button> : null}
      </>} />
      {err ? <Alert tone="danger">{msg(err)}</Alert> : null}
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={<Newspaper className="size-8" />} title={t('business.digest.empty')} hint={t('business.digest.empty_hint')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {q.data.map((d) => (
            <li key={d.id}>
              <Link href={`/app/${access.slug}/digest/${d.id}`} className="flex items-center justify-between rounded-xl border border-line bg-white p-4 hover:border-luma-300">
                <span className="font-medium">{range(d.period_start, d.period_end)}</span>
                <span className="text-xs text-ink-muted">{d.delivered_channels.length ? t('business.digest.sent_via', { channels: d.delivered_channels.join('، ') }) : t('business.digest.in_app')}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Delta({ now, before }: { now: number; before: number }) {
  const { t } = useI18n();
  if (!before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return <span className={pct >= 0 ? 'text-ok' : 'text-danger'} dir="ltr">{t('business.digest.vs_previous', { pct: `${pct >= 0 ? '+' : ''}${pct}%` })}</span>;
}

export function DigestView({ id }: { id: string }) {
  const { t, locale, pick } = useI18n();
  const access = useAccess();
  const { money, qty } = useFmt();
  const range = useRange();
  const q = useApiQuery<Digest>(['digest', access.slug, id], access.api(`/digests/${id}`));
  const Back = locale === 'ar' ? ChevronRight : ChevronLeft;
  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data.payload;
  const n = (v: number) => formatNumber(v, locale);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('business.digest.title')} subtitle={range(q.data.period_start, q.data.period_end)}
        back={<Link href={`/app/${access.slug}/digest`} className="mb-1 inline-flex items-center gap-1 text-sm text-luma-700"><Back className="size-4" />{t('business.digest.all')}</Link>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('business.digest.bookings')} value={n(d.bookings.bookings)} hint={<Delta now={d.bookings.bookings} before={d.bookings.previous.bookings} />} />
        <Stat label={t('business.digest.completed')} value={n(d.bookings.completed)} hint={t('business.digest.cancel_noshow', { c: d.bookings.cancelled, n: d.bookings.no_show })} />
        {d.revenue ? <Stat label={t('business.digest.collections')} value={money(d.revenue.collections_minor)} hint={<Delta now={d.revenue.collections_minor} before={d.revenue.previous_collections_minor} />} /> : null}
        {d.revenue ? <Stat label={t('business.digest.completed_value')} value={money(d.revenue.completed_value_minor)} /> : <Stat label={t('business.digest.new_bookings')} value={n(d.bookings.new_bookings)} />}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('business.digest.top_services')}>
          <BarList label={t('business.digest.top_services')} empty={t('business.digest.none')}
            items={d.top_services.map((s) => ({ key: s.service_id, label: pick(s.name_ar, s.name_en), value: s.bookings, hint: s.value_minor !== null ? money(s.value_minor) : undefined }))} />
        </Card>
        <Card title={t('business.digest.staff')}>
          {d.staff.length ? (
            <table className="w-full text-sm">
              <caption className="sr-only">{t('business.digest.staff')}</caption>
              <thead className="text-xs text-ink-muted"><tr><th className="py-1 text-start font-medium">{t('business.digest.staff_name')}</th><th className="text-end font-medium">{t('business.digest.completed')}</th>{q.data.money ? <th className="text-end font-medium">{t('business.digest.value')}</th> : null}<th className="text-end font-medium">{t('business.digest.rating')}</th></tr></thead>
              <tbody>{d.staff.map((s) => (
                <tr key={s.staff_id} className="border-t border-line">
                  <td className="py-1.5">{s.name}</td><td className="text-end tabular-nums">{n(s.completed)}</td>
                  {q.data.money ? <td className="text-end tabular-nums">{money(s.value_minor ?? 0)}</td> : null}
                  <td className="text-end tabular-nums">{s.rating !== null ? `${s.rating.toFixed(1)} (${s.reviews})` : '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <p className="text-sm text-ink-muted">{t('business.digest.none')}</p>}
        </Card>
        <Card title={t('business.digest.upcoming', { n: d.upcoming.bookings })}>
          <DayColumns points={d.upcoming.days.map((x) => ({ date: x.date, value: x.bookings }))} label={t('business.digest.upcoming', { n: d.upcoming.bookings })} />
          {d.upcoming.expected_value_minor !== null ? <p className="mt-2 text-xs text-ink-muted">{t('business.digest.upcoming_value', { v: money(d.upcoming.expected_value_minor) })}</p> : null}
        </Card>
        <Card title={t('business.digest.low_stock')}>
          {d.low_stock.length ? (
            <ul className="flex flex-col gap-1 text-sm">
              {d.low_stock.map((i) => <li key={i.id} className="flex justify-between gap-2"><span>{i.name}</span><span className="tabular-nums text-warn">{qty(i.available)} / {qty(i.threshold)} {i.unit}</span></li>)}
            </ul>
          ) : <p className="text-sm text-ink-muted">{t('business.digest.stock_ok')}</p>}
          {d.low_stock.length && access.can('inventory.view', 'inventory.manage') ? <Link href={`/app/${access.slug}/inventory`} className="mt-2 inline-block text-xs text-luma-700 underline">{t('business.digest.open_inventory')}</Link> : null}
        </Card>
      </div>
    </div>
  );
}

type DigestSettingsData = { enabled: boolean; weekday: number; hour: number; timezone: string; next_at: string | null; messaging: { whatsapp: string; email: string } };

/** Settings tab: weekly digest day and hour (business-local), or off. */
export function DigestSettingsSection() {
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const qc = useQueryClient();
  const msg = useErrorMessage();
  const key = ['digest-settings', access.slug];
  const q = useApiQuery<DigestSettingsData>(key, access.api('/settings/digest'));
  const [draft, setDraft] = useState<{ enabled: boolean; weekday: number; hour: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (q.isLoading) return <LoadingState />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const v = draft ?? { enabled: q.data.enabled, weekday: q.data.weekday, hour: q.data.hour };
  const set = (p: Partial<typeof v>) => setDraft({ ...v, ...p });
  const hourLabel = (h: number) => (timeFormat === '24h' ? `${String(h).padStart(2, '0')}:00` : new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en', { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1, h))));
  const connected = q.data.messaging.whatsapp === 'connected' || q.data.messaging.email === 'connected';
  return (
    <Card title={t('business.digest.settings_title')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">{t('business.digest.settings_hint')}</p>
        <Checkbox label={t('business.digest.enabled')} checked={v.enabled} onChange={(x) => set({ enabled: x })} disabled={access.readOnly} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('business.digest.weekday')}>{(p) => (
            <Select {...p} value={v.weekday} disabled={!v.enabled || access.readOnly} onChange={(e) => set({ weekday: Number(e.target.value) })}>
              {WEEKDAYS[locale].map((name, i) => <option key={i} value={i}>{name}</option>)}
            </Select>
          )}</Field>
          <Field label={t('business.digest.hour')} hint={t('business.digest.tz', { tz: q.data.timezone })}>{(p) => (
            <Select {...p} value={v.hour} disabled={!v.enabled || access.readOnly} onChange={(e) => set({ hour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </Select>
          )}</Field>
        </div>
        <Alert tone="info">{connected ? t('business.digest.channels_connected') : t('business.digest.channels_in_app')}</Alert>
        {err ? <Alert tone="danger">{msg(err)}</Alert> : null}
        <div className="flex items-center gap-3">
          <Button loading={busy} disabled={!draft || access.readOnly} onClick={async () => {
            setBusy(true); setErr(null);
            try { const r = await api<DigestSettingsData>(access.api('/settings/digest'), { method: 'PUT', body: v }); qc.setQueryData(key, r); setDraft(null); toast({ tone: 'ok', text: t('business.digest.saved') }); }
            catch (e) { setErr(e); } finally { setBusy(false); }
          }}>{t('actions.save')}</Button>
          <Link href={`/app/${access.slug}/digest`} className="text-sm text-luma-700 underline">{t('business.digest.view_all')}</Link>
        </div>
      </div>
    </Card>
  );
}
