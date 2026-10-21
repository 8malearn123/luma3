'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Clock, LogIn, LogOut } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDate, formatDuration, formatTime, tzLabel } from '@/shared/format';
import { api } from '../api';
import { useApiQuery } from '../hooks';
import { Button } from '../components/button';
import { Field, Input, Select } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { ApiErrorBox, localToIso, todayIn } from '../catalog/common';
import type { StaffRow } from './TeamPage';

type Event = { id: string; staff_id: string; kind: 'clock_in' | 'clock_out'; at: string; source: string; note: string | null };

/** Read-only attendance log (clock-in/out events) with an optional clock action. */
export function AttendanceTab({ staff }: { staff: StaffRow[] }) {
  const { t, pick, locale, timeFormat } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = access.can('attendance.manage');
  // Without a staff_id the API returns the caller's own log when she has a staff profile.
  const allowAll = manage && !access.staffProfileId;
  const [staffId, setStaffId] = useState<string>(allowAll ? '' : access.staffProfileId ?? staff[0]?.id ?? '');
  const [from, setFrom] = useState(todayIn(access.timezone, -6));
  const [to, setTo] = useState(todayIn(access.timezone));
  const fromIso = localToIso(`${from}T00:00`, access.timezone);
  const toIso = localToIso(`${to}T23:59`, access.timezone);
  const query = fromIso && toIso ? `?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}${staffId ? `&staff_id=${staffId}` : ''}` : null;
  const q = useApiQuery<Event[]>(['attendance', access.slug, query], query ? access.api(`/attendance${query}`) : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const name = (id: string) => { const s = staff.find((x) => x.id === id); return s ? pick(s.display_name, s.display_name_en) : id === access.staffProfileId ? t('catalog_team.attendance.me') : '—'; };
  const canClock = !access.readOnly && !!staffId && (staffId === access.staffProfileId ? access.can('attendance.own') : manage);

  // Group by staff + local day; worked time = sum of clock_in→clock_out pairs.
  const days = useMemo(() => {
    const out = new Map<string, { staffId: string; day: string; events: Event[]; minutes: number; open: boolean }>();
    for (const e of q.data ?? []) {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: access.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(e.at));
      const k = `${e.staff_id}:${day}`;
      if (!out.has(k)) out.set(k, { staffId: e.staff_id, day, events: [], minutes: 0, open: false });
      out.get(k)!.events.push(e);
    }
    for (const g of out.values()) {
      let start: number | null = null;
      for (const e of g.events) {
        if (e.kind === 'clock_in') start = new Date(e.at).getTime();
        else if (start != null) { g.minutes += Math.round((new Date(e.at).getTime() - start) / 60000); start = null; }
      }
      g.open = start != null;
    }
    return [...out.values()].sort((a, b) => b.day.localeCompare(a.day));
  }, [q.data, access.timezone]);

  async function clock(kind: 'clock_in' | 'clock_out') {
    setBusy(true); setErr(null);
    try {
      await api(access.api('/attendance/clock'), { body: { kind, ...(staffId !== access.staffProfileId ? { staff_id: staffId } : {}) } });
      toast({ tone: 'ok', text: kind === 'clock_in' ? t('catalog_team.attendance.clocked_in') : t('catalog_team.attendance.clocked_out') });
      await qc.invalidateQueries({ queryKey: ['attendance', access.slug] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-[repeat(3,minmax(0,12rem))_1fr] sm:items-end">
        {manage ? (
          <Field label={t('catalog_team.schedule.staff')}>{(fp) => (
            <Select {...fp} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              {allowAll ? <option value="">{t('catalog_team.attendance.everyone')}</option> : null}
              {staff.map((s) => <option key={s.id} value={s.id}>{pick(s.display_name, s.display_name_en)}</option>)}
            </Select>
          )}</Field>
        ) : null}
        <Field label={t('fields.from')}>{(fp) => <Input {...fp} type="date" dir="ltr" max={to} value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('fields.to')}>{(fp) => <Input {...fp} type="date" dir="ltr" min={from} value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        {canClock ? (
          <div className="flex gap-2 sm:justify-end">
            <Button size="sm" variant="outline" icon={<LogIn className="size-4" />} loading={busy} onClick={() => clock('clock_in')}>{t('catalog_team.attendance.clock_in')}</Button>
            <Button size="sm" variant="outline" icon={<LogOut className="size-4" />} loading={busy} onClick={() => clock('clock_out')}>{t('catalog_team.attendance.clock_out')}</Button>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-ink-muted">{t('time.tz_note', { tz: tzLabel(access.timezone, locale) })}</p>
      <ApiErrorBox err={err} />
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !days.length ? (
        <EmptyState icon={<Clock className="size-8" aria-hidden />} title={t('catalog_team.attendance.empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {days.map((g) => (
            <li key={`${g.staffId}:${g.day}`} className="rounded-xl border border-line bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{formatDate(`${g.day}T12:00:00Z`, { tz: 'UTC', locale, weekday: true })}</span>
                {!staffId ? <span className="text-sm text-ink-muted">{name(g.staffId)}</span> : null}
                <Badge tone="info" className="ms-auto">{t('catalog_team.attendance.worked', { d: formatDuration(g.minutes, locale) || '0' })}</Badge>
                {g.open ? <Badge tone="warn">{t('catalog_team.attendance.still_in')}</Badge> : null}
              </div>
              <ul className="mt-2 flex flex-wrap gap-2 text-sm">
                {g.events.map((e) => (
                  <li key={e.id} className="inline-flex items-center gap-1 rounded-lg bg-luma-50 px-2 py-1">
                    {e.kind === 'clock_in' ? <LogIn className="size-3.5 text-ok" aria-hidden /> : <LogOut className="size-3.5 text-ink-muted" aria-hidden />}
                    <span>{t(`catalog_team.attendance.${e.kind}`)}</span>
                    <span dir="ltr">{formatTime(e.at, { tz: access.timezone, locale, timeFormat })}</span>
                    {e.source === 'manager' ? <span className="text-xs text-ink-muted">({t('catalog_team.attendance.by_manager')})</span> : null}
                    {e.note ? <span className="text-xs text-ink-muted">· {e.note}</span> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
