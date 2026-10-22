'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DateTime } from 'luxon';
import { CalendarDays, CircleCheck, Clock, LogIn, LogOut, Play } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { WEEKDAYS, formatClock, tzLabel } from '@/shared/format';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, PageHeader } from '../components/layout';
import { ConfirmDialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { ImageUpload } from '../workspace/ImageUpload';
import { BookingDrawer, type BookingDetail } from '../bookings/BookingDrawer';
import { BookingStatusBadge, parseRange, useBookingFmt, type BookingAction, type BookingRow } from '../bookings/common';

type Schedule = {
  staff: { id: string; display_name: string; is_active: boolean };
  hours: Array<{ id: string; weekday: number; start_time: string; end_time: string; branch_id: string }>;
  breaks: Array<{ id: string; weekday: number | null; start_time: string; end_time: string; label: string | null }>;
  overrides: Array<{ id: string; on_date: string; kind: 'off' | 'replace' | 'extra'; start_time: string | null; end_time: string | null; note: string | null }>;
};
type Leave = { id: string; staff_id: string; during: string; leave_type: string; status: string; reason: string | null; created_at: string };
type Attendance = { id: string; kind: 'clock_in' | 'clock_out'; at: string };
type Profile = { id: string; display_name: string; title_ar: string | null; title_en: string | null; bio_ar: string | null; bio_en: string | null; photo_asset_id: string | null };

const PORTAL_ACTIONS: BookingAction[] = ['check_in', 'start', 'complete'];
const ACTION_ICON = { check_in: LogIn, start: Play, complete: CircleCheck } as const;

/** Staff portal: own appointments, schedule, leave, attendance and profile. */
export function StaffPortal() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const open = sp.get('booking');
  const setOpen = (id: string | null) => {
    const u = new URLSearchParams(sp.toString());
    if (id) u.set('booking', id); else u.delete('booking');
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  };

  if (!access.staffProfileId) {
    return (
      <div>
        <PageHeader title={t('nav.me')} />
        <Alert tone="info">{t('staff_portal.not_linked')}</Alert>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <PageHeader title={t('nav.me')} subtitle={t('time.tz_note', { tz: tzLabel(access.timezone, locale) })} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <MyBookings staffId={access.staffProfileId} onOpen={setOpen} />
          <MySchedule staffId={access.staffProfileId} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {access.can('attendance.own') ? <ClockCard /> : null}
          {access.can('leave.request', 'schedule.manage') ? <LeaveCard staffId={access.staffProfileId} /> : null}
          <ProfileCard />
        </div>
      </div>
      {open ? <BookingDrawer key={open} bookingId={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function MyBookings({ staffId, onOpen }: { staffId: string; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const { time, day } = useBookingFmt();
  const tz = access.timezone;
  const today = DateTime.now().setZone(tz).startOf('day');
  const from = today.toISO()!, to = today.plus({ days: 14 }).toISO()!;
  const path = access.api(`/bookings?staff_id=${staffId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=held,pending_approval,pending_payment,confirmed,checked_in,in_service,completed,no_show&limit=100`);
  const list = useApiQuery<BookingRow[]>(['portal', access.slug, 'bookings', from], path, { refetchInterval: 60_000 });
  const rows = list.data ?? [];
  const todays = rows.filter((r) => DateTime.fromISO(r.starts_at, { zone: r.timezone }).hasSame(today, 'day'));
  const upcoming = rows.filter((r) => !todays.includes(r) && !['completed', 'no_show'].includes(r.status));
  const mine = (r: BookingRow) => r.segments.filter((s) => s.staff_id === staffId);

  return (
    <>
      <Card title={t('staff_portal.today')}>
        {list.isLoading ? <LoadingState rows={3} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !todays.length ? (
          <EmptyState icon={<CalendarDays className="size-8" aria-hidden />} title={t('me_portal.no_today')} />
        ) : (
          <ul className="flex flex-col gap-2">
            {todays.map((r) => <TodayItem key={r.id} row={r} segments={mine(r)} onOpen={onOpen} />)}
          </ul>
        )}
      </Card>
      <Card title={t('me_portal.upcoming')}>
        {list.isLoading ? <LoadingState rows={2} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !upcoming.length ? (
          <EmptyState title={t('staff_portal.no_bookings')} />
        ) : (
          <ul className="divide-y divide-line">
            {upcoming.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onOpen(r.id)} className="flex w-full flex-wrap items-center justify-between gap-2 py-2 text-start hover:bg-luma-50">
                  <span className="min-w-0">
                    <span className="block font-medium">{day(r.starts_at, r.timezone)} · <bdi>{time(mine(r)[0]?.starts_at ?? r.starts_at, r.timezone)}</bdi></span>
                    <span className="block truncate text-xs text-ink-muted">{r.customer_name} · {r.services}</span>
                  </span>
                  <BookingStatusBadge status={r.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** Today's appointment with the lifecycle actions the API allows (fetched per booking). */
function TodayItem({ row, segments, onOpen }: { row: BookingRow; segments: BookingRow['segments']; onOpen: (id: string) => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const { time } = useBookingFmt();
  const detail = useApiQuery<BookingDetail>(['booking', access.slug, row.id], access.api(`/bookings/${row.id}`));
  const canAct = !access.readOnly && access.can('bookings.manage', 'bookings.manage_assigned');
  const actions = canAct ? (detail.data?.available_actions ?? []).filter((a) => PORTAL_ACTIONS.includes(a)) : [];
  const [confirm, setConfirm] = useState<BookingAction | null>(null);
  const m = useApiMutation((a: BookingAction) => api(access.api(`/bookings/${row.id}/transition`), { body: { action: a, version: detail.data?.version } }), {
    invalidate: [['portal', access.slug], ['booking', access.slug, row.id], ['bookings', access.slug]],
    onSuccess: () => { setConfirm(null); toast({ tone: 'ok', text: t('bookings_ui.detail.done') }); },
  });
  const segs = segments.length ? segments : row.segments;
  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button type="button" className="min-w-0 text-start" onClick={() => onOpen(row.id)}>
          <span className="block font-semibold">{time(segs[0]?.starts_at ?? row.starts_at, row.timezone)} – {time(segs[segs.length - 1]?.ends_at ?? row.ends_at, row.timezone)}</span>
          <span className="block font-medium">{row.customer_name}</span>
          <span className="block text-xs text-ink-muted">{segs.map((s) => pick(s.service_name_ar, s.service_name_en)).join(' + ')}</span>
        </button>
        <BookingStatusBadge status={detail.data?.status ?? row.status} />
      </div>
      {actions.length ? (
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {actions.map((a, i) => {
            const Icon = ACTION_ICON[a as keyof typeof ACTION_ICON];
            return <Button key={a} size="sm" variant={i === 0 ? 'primary' : 'outline'} icon={<Icon className="size-4" />} onClick={() => setConfirm(a)}>{t(`booking.actions.${a}`)}</Button>;
          })}
        </div>
      ) : null}
      {detail.error ? <p className="mt-1 text-xs text-danger" role="alert">{msg(detail.error)}</p> : null}
      <ConfirmDialog open={!!confirm} onClose={() => { setConfirm(null); m.reset(); }} loading={m.isPending}
        title={confirm ? t('bookings_ui.confirm.title', { action: t(`booking.actions.${confirm}`) }) : ''}
        body={<div className="flex flex-col gap-2">{m.error ? <FormErrorSummary message={msg(m.error)} /> : null}<p className="text-ink-muted">{confirm ? t(`bookings_ui.confirm.${confirm}`, { number: row.number }) : ''}</p></div>}
        confirmLabel={confirm ? t(`booking.actions.${confirm}`) : undefined} onConfirm={() => confirm && m.mutate(confirm)} />
    </li>
  );
}

function MySchedule({ staffId }: { staffId: string }) {
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const today = DateTime.now().setZone(access.timezone);
  const from = today.toISODate()!, to = today.plus({ days: 60 }).toISODate()!;
  const q = useApiQuery<Schedule>(['portal', access.slug, 'schedule', from], access.api(`/staff/${staffId}/schedule?from=${from}&to=${to}`));
  const clock = (s: string) => formatClock(s.slice(0, 5), locale, timeFormat);
  return (
    <Card title={t('me_portal.schedule')}>
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-ink-muted">{t('me_portal.schedule_readonly')}</p>
          <table className="w-full text-sm">
            <caption className="sr-only">{t('me_portal.weekly')}</caption>
            <tbody>
              {WEEKDAYS[locale].map((name, d) => {
                const ranges = q.data!.hours.filter((h) => h.weekday === d).sort((a, b) => a.start_time.localeCompare(b.start_time));
                const brks = q.data!.breaks.filter((b) => b.weekday === d);
                return (
                  <tr key={d} className="border-t border-line first:border-t-0">
                    <th scope="row" className="w-28 py-1.5 text-start font-medium">{name}</th>
                    <td className="py-1.5">
                      {ranges.length ? <span className="inline-block">{ranges.map((r) => `${clock(r.start_time)} – ${clock(r.end_time)}`).join('، ')}</span> : <span className="text-ink-muted">{t('me_portal.day_off')}</span>}
                      {brks.length ? <span className="block text-xs text-ink-muted">{t('me_portal.break')}: <span>{brks.map((b) => `${clock(b.start_time)} – ${clock(b.end_time)}`).join(', ')}</span></span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div>
            <h3 className="mb-1 text-sm font-semibold">{t('me_portal.overrides')}</h3>
            {!q.data.overrides.length ? <p className="text-sm text-ink-muted">{t('me_portal.no_overrides')}</p> : (
              <ul className="flex flex-col gap-1 text-sm">
                {q.data.overrides.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{DateTime.fromISO(o.on_date).setLocale(locale).toFormat('cccc d LLL')}</span>
                    <Badge tone={o.kind === 'off' ? 'warn' : 'info'}>{t(`me_portal.override.${o.kind}`)}</Badge>
                    {o.start_time && o.end_time ? <span>{clock(o.start_time)} – {clock(o.end_time)}</span> : null}
                    {o.note ? <span className="text-xs text-ink-muted">{o.note}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function ClockCard() {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { time, day } = useBookingFmt();
  const [range] = useState(() => ({ from: DateTime.now().minus({ days: 30 }).toISO()!, to: DateTime.now().plus({ days: 1 }).toISO()! }));
  const q = useApiQuery<Attendance[]>(['portal', access.slug, 'attendance'], access.api(`/attendance?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`));
  const last = q.data?.length ? q.data[q.data.length - 1] : null;
  const inNow = last?.kind === 'clock_in';
  const [confirm, setConfirm] = useState(false);
  const m = useApiMutation((kind: 'clock_in' | 'clock_out') => api(access.api('/attendance/clock'), { body: { kind } }), {
    invalidate: [['portal', access.slug, 'attendance']], onSuccess: () => setConfirm(false),
  });
  return (
    <Card title={<span className="inline-flex items-center gap-1"><Clock className="size-4" aria-hidden />{t('me_portal.attendance')}</span>}>
      {q.isLoading ? <LoadingState rows={1} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="flex flex-col gap-3">
          <p className="text-sm" role="status">
            {inNow && last ? t('staff_portal.clocked_in_since', { time: `${day(last.at)} ${time(last.at)}` }) : last ? t('me_portal.clocked_out_at', { time: `${day(last.at)} ${time(last.at)}` }) : t('me_portal.not_clocked_in')}
          </p>
          {m.error && !confirm ? <p className="text-xs text-danger" role="alert">{msg(m.error)}</p> : null}
          {!access.readOnly ? (
            <Button variant={inNow ? 'outline' : 'primary'} icon={inNow ? <LogOut className="size-4" /> : <LogIn className="size-4" />} loading={m.isPending && !confirm}
              onClick={() => (inNow ? setConfirm(true) : m.mutate('clock_in'))}>
              {inNow ? t('staff_portal.clock_out') : t('staff_portal.clock_in')}
            </Button>
          ) : null}
        </div>
      )}
      <ConfirmDialog open={confirm} onClose={() => { setConfirm(false); m.reset(); }} loading={m.isPending} title={t('staff_portal.clock_out')}
        body={<div className="flex flex-col gap-2">{m.error ? <FormErrorSummary message={msg(m.error)} /> : null}<p className="text-ink-muted">{t('me_portal.clock_out_confirm')}</p></div>}
        confirmLabel={t('staff_portal.clock_out')} onConfirm={() => m.mutate('clock_out')} />
    </Card>
  );
}

function LeaveCard({ staffId }: { staffId: string }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const tz = access.timezone;
  const list = useApiQuery<Leave[]>(['portal', access.slug, 'leave'], access.api('/leave'));
  const mine = (list.data ?? []).filter((l) => l.staff_id === staffId);
  const today = DateTime.now().setZone(tz).toISODate()!;
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [type, setType] = useState('annual');
  const [reason, setReason] = useState('');
  useUnsavedChangesWarning(!!reason.trim());
  const start = DateTime.fromISO(from, { zone: tz }), end = DateTime.fromISO(to, { zone: tz });
  const invalid = !start.isValid || !end.isValid || end < start;
  const m = useApiMutation(() => api(access.api('/leave'), { body: { starts_at: start.startOf('day').toISO(), ends_at: end.plus({ days: 1 }).startOf('day').toISO(), leave_type: type, ...(reason.trim() ? { reason: reason.trim() } : {}) } }), {
    invalidate: [['portal', access.slug, 'leave']],
    onSuccess: () => { setReason(''); toast({ tone: 'ok', text: t('me_portal.leave_sent') }); },
  });
  const fmtDay = (iso: string) => DateTime.fromISO(iso, { zone: tz }).setLocale(locale).toFormat('d LLL yyyy');
  const statusTone = (s: string) => (s === 'approved' ? 'ok' : s === 'rejected' ? 'danger' : s === 'cancelled' ? 'neutral' : 'warn');
  return (
    <Card title={t('staff_portal.request_leave')}>
      {access.readOnly ? null : (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (!invalid) m.mutate(undefined); }}>
          <FormErrorSummary message={m.error ? msg(m.error) : null} />
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('staff_portal.leave_from')} required>{(p) => <Input {...p} type="date" dir="ltr" min={today} value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} />}</Field>
            <Field label={t('staff_portal.leave_to')} required error={invalid ? t('me_portal.leave_range_invalid') : null}>{(p) => <Input {...p} type="date" dir="ltr" min={from} value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          </div>
          <Field label={t('staff_portal.leave_type')}>{(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value)}>
              {(['annual', 'sick', 'personal', 'other'] as const).map((k) => <option key={k} value={k}>{t(`staff_portal.leave_types.${k}`)}</option>)}
            </Select>
          )}</Field>
          <Field label={t('fields.reason')} hint={t('fields.optional')}>{(p) => <Textarea {...p} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <Button type="submit" loading={m.isPending} disabled={invalid} className="self-start">{t('actions.submit')}</Button>
        </form>
      )}
      <h3 className="mb-1 mt-4 text-sm font-semibold">{t('staff_portal.my_leave')}</h3>
      {list.isLoading ? <LoadingState rows={2} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !mine.length ? (
        <p className="text-sm text-ink-muted">{t('me_portal.no_leave')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {mine.map((l) => {
            const r = parseRange(l.during);
            const last = r ? DateTime.fromISO(r.to).minus({ milliseconds: 1 }).toISO()! : null;
            return (
              <li key={l.id} className="rounded-lg border border-line p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{r ? (fmtDay(r.from) === fmtDay(last!) ? fmtDay(r.from) : `${fmtDay(r.from)} – ${fmtDay(last!)}`) : '—'}</span>
                  <Badge tone={statusTone(l.status)}>{t(`me_portal.leave_status.${l.status}`)}</Badge>
                </div>
                <p className="text-xs text-ink-muted">{t(`staff_portal.leave_types.${l.leave_type}`)}{l.reason ? ` · ${l.reason}` : ''}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ProfileCard() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const q = useApiQuery<Profile>(['portal', access.slug, 'profile'], access.api('/me/profile'));
  const canEdit = access.can('staff.edit_own_profile') && !access.readOnly;
  return (
    <Card title={t('staff_portal.my_profile')}>
      {q.isLoading ? <LoadingState rows={2} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? (
        <>
          <p className="font-medium">{q.data.display_name}</p>
          {q.data.title_ar || q.data.title_en ? <p className="mb-2 text-sm text-ink-muted">{pick(q.data.title_ar, q.data.title_en)}</p> : null}
          {canEdit ? <ProfileForm key={q.data.id} profile={q.data} onSaved={() => { q.refetch(); toast({ tone: 'ok', text: t('states.saved') }); }} /> : (
            <p className="whitespace-pre-line text-sm">{pick(q.data.bio_ar, q.data.bio_en) || <span className="text-ink-muted">{t('states.none')}</span>}</p>
          )}
        </>
      ) : null}
    </Card>
  );
}

function ProfileForm({ profile, onSaved }: { profile: Profile; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [bioAr, setBioAr] = useState(profile.bio_ar ?? '');
  const [bioEn, setBioEn] = useState(profile.bio_en ?? '');
  const [photo, setPhoto] = useState<string | null>(profile.photo_asset_id);
  const dirty = bioAr !== (profile.bio_ar ?? '') || bioEn !== (profile.bio_en ?? '') || photo !== profile.photo_asset_id;
  useUnsavedChangesWarning(dirty);
  const m = useApiMutation(() => api(access.api('/me/profile'), { method: 'PATCH', body: { bio_ar: bioAr.trim() || null, bio_en: bioEn.trim() || null, photo_asset_id: photo } }), {
    invalidate: [['portal', access.slug, 'profile']], onSuccess: () => onSaved(),
  });
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); m.mutate(undefined); }}>
      <FormErrorSummary message={m.error ? msg(m.error) : null} />
      <ImageUpload slug={access.slug} purpose="staff" value={photo} onChange={setPhoto} label={t('me_portal.photo')} />
      <Field label={`${t('staff_portal.bio')} (${t('me_portal.arabic')})`}>{(p) => <Textarea {...p} dir="rtl" lang="ar" rows={3} maxLength={2000} value={bioAr} onChange={(e) => setBioAr(e.target.value)} />}</Field>
      <Field label={`${t('staff_portal.bio')} (${t('me_portal.english')})`}>{(p) => <Textarea {...p} dir="ltr" lang="en" rows={3} maxLength={2000} value={bioEn} onChange={(e) => setBioEn(e.target.value)} />}</Field>
      <p className="text-xs text-ink-muted">{t('me_portal.profile_note')}</p>
      <Button type="submit" className="self-start" loading={m.isPending} disabled={!dirty}>{t('actions.save')}</Button>
    </form>
  );
}
