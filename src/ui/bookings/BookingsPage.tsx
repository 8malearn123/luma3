'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { CalendarDays, ChevronLeft, ChevronRight, List, Plus, Search } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { tzLabel } from '@/shared/format';
import { ApiError } from '../api';
import { useDebounced } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Input, Select } from '../components/form';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { DataTable, PageHeader, Pager, type Column } from '../components/layout';
import { cx } from '../components/cx';
import { useAccess } from '../shell/access-context';
import { BookingCalendar } from './BookingCalendar';
import { BookingDrawer } from './BookingDrawer';
import { NewBookingDrawer } from './NewBookingDrawer';
import { BookingStatusBadge, PaymentStatusBadge, STATUSES, useBookingFmt, useBranches, useFinancialAccess, useStaffList, type BookingRow } from './common';

const LIMIT = 25;
type Preset = 'today' | 'upcoming' | 'all' | 'range';

/** GET with the response envelope's meta (the shared api() helper returns only `data`). */
export async function fetchPage<T>(path: string, signal?: AbortSignal): Promise<{ data: T; meta: { next_cursor?: string | null } }> {
  let res: Response;
  try { res = await fetch(path, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal }); } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', 'Network error');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'internal_error', json?.error?.message ?? res.statusText, json?.error?.details, json?.error?.request_id);
  return { data: json?.data as T, meta: json?.meta ?? {} };
}

function qs(p: Record<string, string | number | null | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export function BookingsPage() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { when, money } = useBookingFmt();
  const financial = useFinancialAccess();
  const tz = access.timezone;
  const staffList = useStaffList();
  const branches = useBranches();
  const activeBranches = (branches.data?.items ?? []).filter((b) => b.status === 'active');

  const open = sp.get('booking');
  const setParam = (k: string, v: string | null) => {
    const u = new URLSearchParams(sp.toString());
    if (v) u.set(k, v); else u.delete(k);
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  };
  const view = sp.get('view') === 'calendar' ? 'calendar' : 'list';

  // Default (and the `?upcoming=1` deep link from notifications) is upcoming bookings.
  const [preset, setPreset] = useState<Preset>('upcoming');
  const today = DateTime.now().setZone(tz).startOf('day');
  const [fromDate, setFromDate] = useState(today.toISODate()!);
  const [toDate, setToDate] = useState(today.plus({ days: 7 }).toISODate()!);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [staffId, setStaffId] = useState(sp.get('staff') ?? '');
  const [branchId, setBranchId] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const resetPage = () => setCursors([null]);
  const [newOpen, setNewOpen] = useState(false);

  const range = (() => {
    if (preset === 'today') return { from: today.toISO()!, to: today.plus({ days: 1 }).toISO()! };
    if (preset === 'upcoming') return { from: today.toISO()!, to: undefined };
    if (preset === 'range') {
      const f = DateTime.fromISO(fromDate, { zone: tz }), tt = DateTime.fromISO(toDate, { zone: tz });
      return { from: f.isValid ? f.toISO()! : undefined, to: tt.isValid ? tt.plus({ days: 1 }).toISO()! : undefined };
    }
    return { from: undefined, to: undefined };
  })();

  const cursor = cursors[cursors.length - 1];
  const listQs = qs({ from: range.from, to: range.to, status: statuses.join(','), staff_id: staffId, branch_id: branchId, q, limit: LIMIT, cursor });
  const list = useQuery({
    queryKey: ['bookings', access.slug, 'list', listQs],
    queryFn: ({ signal }) => fetchPage<BookingRow[]>(access.api(`/bookings${listQs}`), signal),
    enabled: view === 'list',
    refetchInterval: 60_000,
  });

  // Calendar
  const [calMode, setCalMode] = useState<'day' | 'week'>('day');
  const [anchor, setAnchor] = useState(today);
  const calFrom = anchor.startOf('day');
  const calTo = calFrom.plus({ days: calMode === 'day' ? 1 : 7 });
  const calQs = qs({ from: calFrom.toISO(), to: calTo.toISO(), staff_id: staffId, branch_id: branchId, status: statuses.join(','), q });
  const cal = useQuery({
    queryKey: ['bookings', access.slug, 'calendar', calQs],
    enabled: view === 'calendar',
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const out: BookingRow[] = [];
      let next: string | null | undefined = null;
      for (let i = 0; i < 6; i++) {
        const r: { data: BookingRow[]; meta: { next_cursor?: string | null } } = await fetchPage<BookingRow[]>(access.api(`/bookings${calQs}${calQs ? '&' : '?'}limit=100${next ? `&cursor=${encodeURIComponent(next)}` : ''}`), signal);
        out.push(...r.data);
        next = r.meta.next_cursor;
        if (!next) break;
      }
      return { rows: out, truncated: !!next };
    },
  });

  const toggleStatus = (s: string) => { setStatuses((xs) => (xs.includes(s) ? xs.filter((x) => x !== s) : [...xs, s])); resetPage(); };
  const Prev = locale === 'ar' ? ChevronRight : ChevronLeft;
  const Next = locale === 'ar' ? ChevronLeft : ChevronRight;
  const canCreate = access.can('bookings.manage') && !access.readOnly;

  const columns: Column<BookingRow>[] = [
    {
      key: 'when', header: t('booking.dashboard.when'), cell: (r) => (
        <div><p className="whitespace-nowrap font-medium">{when(r.starts_at, r.timezone)}</p><p dir="ltr" className="font-mono text-xs text-ink-muted">{r.number}</p></div>
      ),
    },
    {
      key: 'customer', header: t('booking.dashboard.customer'), cell: (r) => (
        <div className="min-w-0"><p className="font-medium">{r.customer_name}</p><p className="text-xs text-ink-muted">{r.services}</p><p className="text-xs text-ink-muted sm:hidden">{r.staff_names}</p></div>
      ),
    },
    { key: 'staff', header: t('booking.dashboard.staff'), className: 'hidden sm:table-cell', cell: (r) => <span className="text-sm">{r.staff_names}</span> },
    {
      key: 'status', header: t('booking.dashboard.status_filter'), cell: (r) => (
        <span className="flex flex-wrap gap-1"><BookingStatusBadge status={r.status} />{financial ? <span className="hidden sm:inline-flex"><PaymentStatusBadge status={r.payment_status} /></span> : null}</span>
      ),
    },
    ...(financial ? [{ key: 'amount', header: t('booking.dashboard.amount'), className: 'hidden md:table-cell', cell: (r: BookingRow) => (r.total_minor != null ? <span dir="ltr">{money(r.total_minor)}</span> : null) }] : []),
  ];

  const presets: Preset[] = ['today', 'upcoming', 'all', 'range'];

  return (
    <div className="min-w-0">
      <PageHeader title={t('booking.dashboard.title')} subtitle={t('time.tz_note', { tz: tzLabel(tz, locale) })}
        actions={<>
          <div role="group" aria-label={t('bookings_ui.view')} className="inline-flex rounded-lg border border-line bg-white p-0.5">
            <button type="button" aria-pressed={view === 'list'} onClick={() => setParam('view', null)} className={cx('inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm', view === 'list' ? 'bg-luma-700 text-white' : 'text-ink-muted')}><List className="size-4" aria-hidden />{t('booking.dashboard.list')}</button>
            <button type="button" aria-pressed={view === 'calendar'} onClick={() => setParam('view', 'calendar')} className={cx('inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm', view === 'calendar' ? 'bg-luma-700 text-white' : 'text-ink-muted')}><CalendarDays className="size-4" aria-hidden />{t('booking.dashboard.calendar')}</button>
          </div>
          {canCreate ? <Button icon={<Plus className="size-4" />} onClick={() => setNewOpen(true)}>{t('booking.dashboard.new')}</Button> : null}
        </>} />

      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-end">
        <div className="relative lg:w-72">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-muted" aria-hidden />
          <Input aria-label={t('actions.search')} placeholder={t('booking.dashboard.search')} className="ps-9" value={search} onChange={(e) => { setSearch(e.target.value); resetPage(); }} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          {staffList.data ? (
            <Select aria-label={t('booking.dashboard.staff_filter')} className="sm:w-48" value={staffId} onChange={(e) => { setStaffId(e.target.value); resetPage(); }}>
              <option value="">{t('bookings_ui.filters.all_staff')}</option>
              {staffList.data.filter((s) => !s.is_active ? s.id === staffId : true).map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
            </Select>
          ) : null}
          {activeBranches.length > 1 ? (
            <Select aria-label={t('fields.branch')} className="sm:w-48" value={branchId} onChange={(e) => { setBranchId(e.target.value); resetPage(); }}>
              <option value="">{t('bookings_ui.filters.all_branches')}</option>
              {activeBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          ) : null}
        </div>
      </div>

      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label={t('booking.dashboard.status_filter')}>
        {STATUSES.map((s) => (
          <button key={s} type="button" aria-pressed={statuses.includes(s)} onClick={() => toggleStatus(s)}
            className={cx('whitespace-nowrap rounded-full border px-3 py-1 text-xs', statuses.includes(s) ? 'border-luma-700 bg-luma-700 text-white' : 'border-line bg-white text-ink-muted hover:bg-luma-50')}>
            {t(`booking.status.${s}`)}
          </button>
        ))}
        {statuses.length ? <button type="button" className="whitespace-nowrap px-2 text-xs underline" onClick={() => { setStatuses([]); resetPage(); }}>{t('actions.clear')}</button> : null}
      </div>

      {view === 'list' ? (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <div role="group" aria-label={t('bookings_ui.filters.period')} className="flex flex-wrap gap-1">
              {presets.map((p) => (
                <button key={p} type="button" aria-pressed={preset === p} onClick={() => { setPreset(p); resetPage(); }}
                  className={cx('rounded-lg px-3 py-1.5 text-sm', preset === p ? 'bg-luma-100 font-semibold text-luma-800' : 'text-ink-muted hover:bg-luma-50')}>
                  {p === 'range' ? t('bookings_ui.filters.range') : t(`booking.dashboard.${p}`)}
                </button>
              ))}
            </div>
            {preset === 'range' ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-1">{t('fields.from')}<span className="w-40"><Input type="date" dir="ltr" value={fromDate} onChange={(e) => { setFromDate(e.target.value); resetPage(); }} /></span></label>
                <label className="flex items-center gap-1">{t('fields.to')}<span className="w-40"><Input type="date" dir="ltr" value={toDate} min={fromDate} onChange={(e) => { setToDate(e.target.value); resetPage(); }} /></span></label>
              </div>
            ) : null}
          </div>
          {list.isLoading ? <LoadingState rows={5} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.data.length ? (
            <EmptyState icon={<CalendarDays className="size-8" aria-hidden />} title={t('booking.dashboard.no_bookings')} hint={t('bookings_ui.empty_hint')}
              action={canCreate ? <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setNewOpen(true)}>{t('booking.dashboard.new')}</Button> : undefined} />
          ) : (
            <>
              <DataTable rows={list.data.data} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => setParam('booking', r.id)} caption={t('booking.dashboard.title')} />
              <Pager hasPrev={cursors.length > 1} hasNext={!!list.data.meta.next_cursor}
                onPrev={() => setCursors((c) => c.slice(0, -1))} onNext={() => setCursors((c) => [...c, list.data!.meta.next_cursor ?? null])} />
            </>
          )}
        </>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t('bookings_ui.view')} className="inline-flex rounded-lg border border-line bg-white p-0.5">
              {(['day', 'week'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={calMode === m} onClick={() => setCalMode(m)} className={cx('rounded-md px-3 py-1 text-sm', calMode === m ? 'bg-luma-100 font-semibold text-luma-800' : 'text-ink-muted')}>{t(`bookings_ui.calendar.${m}`)}</button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <IconButton label={calMode === 'day' ? t('booking.dashboard.prev_day') : t('bookings_ui.calendar.prev_week')} onClick={() => setAnchor(anchor.minus({ days: calMode === 'day' ? 1 : 7 }))}><Prev className="size-4" /></IconButton>
              <Button size="sm" variant="ghost" onClick={() => setAnchor(today)}>{t('booking.dashboard.today')}</Button>
              <IconButton label={calMode === 'day' ? t('booking.dashboard.next_day') : t('bookings_ui.calendar.next_week')} onClick={() => setAnchor(anchor.plus({ days: calMode === 'day' ? 1 : 7 }))}><Next className="size-4" /></IconButton>
            </div>
            <span className="text-sm font-medium">
              {calMode === 'day' ? anchor.setLocale(locale).toFormat('cccc d LLLL yyyy') : `${calFrom.setLocale(locale).toFormat('d LLL')} – ${calTo.minus({ days: 1 }).setLocale(locale).toFormat('d LLL yyyy')}`}
            </span>
            <span className="w-40"><Input type="date" dir="ltr" aria-label={t('fields.date')} value={anchor.toISODate()!} onChange={(e) => { const d = DateTime.fromISO(e.target.value, { zone: tz }); if (d.isValid) setAnchor(d); }} /></span>
          </div>
          {cal.isLoading ? <LoadingState rows={6} /> : cal.error ? <ErrorState error={cal.error} onRetry={() => cal.refetch()} /> : cal.data ? (
            <>
              {!cal.data.rows.filter((r) => !['cancelled', 'expired'].includes(r.status)).length ? <p className="mb-2 text-sm text-ink-muted">{t('booking.dashboard.no_bookings')}</p> : null}
              {cal.data.truncated ? <p className="mb-2 text-xs text-warn">{t('bookings_ui.calendar.truncated')}</p> : null}
              <BookingCalendar rows={cal.data.rows} mode={calMode} anchor={anchor} tz={tz} staff={staffList.data} staffFilter={staffId || undefined} onOpen={(id) => setParam('booking', id)} />
            </>
          ) : null}
        </>
      )}

      {open ? <BookingDrawer key={open} bookingId={open} onClose={() => setParam('booking', null)} /> : null}
      {newOpen ? <NewBookingDrawer onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); setParam('booking', id); }} /> : null}
    </div>
  );
}
