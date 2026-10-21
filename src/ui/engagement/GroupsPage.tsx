'use client';

import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { CalendarClock, Plus, UsersRound } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDuration } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { PageHeader, Tabs } from '../components/layout';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { ReasonDialog, useMountTime } from './shared';

type Session = { id: string; title_ar: string | null; title_en: string | null; starts_at: string; ends_at: string; capacity: number; seats_taken: number; price_minor: number; status: string; service_id: string; staff_name: string };
type Service = { id: string; name_ar: string | null; name_en: string | null; booking_mode: string; price_minor: number; duration_min: number; is_active: boolean; archived_at: string | null; staff: Array<{ staff_id: string; display_name: string; is_active: boolean }> };
type Branch = { id: string; name_ar?: string | null; name_en?: string | null; name?: string | null; status: string; is_primary: boolean; timezone: string };

export function GroupsPage() {
  const { t, pick, locale } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const toast = useToast();
  const [view, setView] = useState<'upcoming' | 'past' | 'cancelled'>('upcoming');
  const list = useApiQuery<Session[]>(['groups', access.slug], access.api('/group-sessions'));
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<Session | null>(null);
  const canManage = access.can('bookings.manage') && !access.readOnly;
  const now = useMountTime();
  const rows = (list.data ?? []).filter((s) => (view === 'cancelled' ? s.status === 'cancelled' : s.status !== 'cancelled' && (view === 'upcoming' ? Date.parse(s.ends_at) >= now : Date.parse(s.ends_at) < now)));
  if (view === 'past') rows.reverse();

  return (
    <div>
      <PageHeader title={t('engagement.groups.title')} subtitle={t('fe.groups.subtitle')} actions={canManage ? <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('engagement.groups.new')}</Button> : null} />
      <Tabs value={view} onChange={setView} items={[{ value: 'upcoming', label: t('fe.groups.upcoming') }, { value: 'past', label: t('fe.groups.past') }, { value: 'cancelled', label: t('fe.groups.cancelled') }]} />
      {list.isLoading ? <LoadingState rows={4} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? (
        <EmptyState icon={<UsersRound className="size-8" aria-hidden />} title={t('fe.groups.empty')} hint={canManage ? t('fe.groups.empty_hint') : undefined} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {rows.map((s) => {
            const pct = s.capacity ? Math.min(100, (s.seats_taken / s.capacity) * 100) : 0;
            const full = s.seats_taken >= s.capacity;
            return (
              <li key={s.id} className="flex flex-col rounded-2xl border border-line bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-luma-900">{pick(s.title_ar, s.title_en)}</p>
                    <p className="flex items-center gap-1 text-sm"><CalendarClock className="size-4 text-ink-muted" aria-hidden />{when(s.starts_at)}</p>
                    <p className="text-xs text-ink-muted">{t('engagement.groups.instructor')}: <bdi>{s.staff_name}</bdi> · {formatDuration(Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60000), locale)}</p>
                  </div>
                  <Badge tone={s.status === 'cancelled' ? 'neutral' : full ? 'warn' : 'ok'}>{s.status === 'cancelled' ? t('fe.groups.status_cancelled') : full ? t('engagement.groups.full') : t('engagement.groups.seats_left', { n: s.capacity - s.seats_taken })}</Badge>
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex justify-between text-xs"><span>{t('engagement.groups.seats')}</span><span dir="ltr" className="font-medium">{s.seats_taken} / {s.capacity}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-luma-100" role="progressbar" aria-valuemin={0} aria-valuemax={s.capacity} aria-valuenow={s.seats_taken} aria-label={t('engagement.groups.seats')}>
                    <div className="h-full rounded-full bg-luma-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2 text-sm">
                  <span>{t('fe.groups.price_per_seat')}: <span dir="ltr" className="font-medium">{money(s.price_minor)}</span></span>
                  {canManage && s.status === 'scheduled' && Date.parse(s.starts_at) > now ? <Button size="sm" variant="ghost" className="text-danger" onClick={() => setCancelling(s)}>{t('engagement.groups.cancel_session')}</Button> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {creating ? <SessionDrawer onClose={() => setCreating(false)} onSaved={() => { setCreating(false); list.refetch(); toast({ tone: 'ok', text: t('fe.groups.created') }); }} /> : null}
      <ReasonDialog open={!!cancelling} onClose={() => setCancelling(null)} title={t('fe.groups.cancel_title')} confirmLabel={t('engagement.groups.cancel_session')}
        body={cancelling ? t('fe.groups.cancel_body', { n: cancelling.seats_taken }) : null}
        onConfirm={async (reason) => {
          const r = await api<{ cancelled_bookings: number }>(access.api(`/group-sessions/${cancelling!.id}/cancel`), { body: { reason } });
          setCancelling(null); await list.refetch(); toast({ tone: 'ok', text: t('fe.groups.cancelled_ok', { n: r.cancelled_bookings }) });
        }} />
    </div>
  );
}

function SessionDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, pick, locale } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { money } = useFmt();
  const services = useApiQuery<Service[]>(['fe-services', access.slug], access.api('/services'));
  const branches = useApiQuery<{ items: Branch[] }>(['fe-branches', access.slug], access.api('/branches?include_archived=0'));
  const groupServices = useMemo(() => (services.data ?? []).filter((s) => s.booking_mode === 'group' && s.is_active && !s.archived_at), [services.data]);
  const [f, setF] = useState({ service_id: '', staff_id: '', branch_id: '', start: '', capacity: '8', price: null as number | null, title_ar: '', title_en: '' });
  const [confirm, setConfirm] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  useUnsavedChangesWarning(!!f.service_id || !!f.start);
  const svc = groupServices.find((s) => s.id === f.service_id);
  const branchId = f.branch_id || branches.data?.items.find((b) => b.is_primary)?.id || branches.data?.items[0]?.id || '';
  const branch = branches.data?.items.find((b) => b.id === branchId);
  const tz = branch?.timezone ?? access.timezone;
  const start = f.start ? DateTime.fromISO(f.start, { zone: tz }) : null;
  const capacity = Number(f.capacity);
  const mountedAt = useMountTime();
  const ok = !!svc && !!f.staff_id && !!branchId && !!start?.isValid && start.toMillis() > mountedAt && Number.isInteger(capacity) && capacity >= 1 && capacity <= 500;
  const save = useApiMutation<void, unknown>(() => api(access.api('/group-sessions'), {
    body: {
      branch_id: branchId, service_id: f.service_id, staff_id: f.staff_id, starts_at: start!.toISO(), capacity,
      ...(f.price != null ? { price_minor: f.price } : {}), ...(f.title_ar.trim() ? { title_ar: f.title_ar.trim() } : {}), ...(f.title_en.trim() ? { title_en: f.title_en.trim() } : {}),
    },
  }), { onSuccess: onSaved });
  const issues = save.error instanceof ApiError && save.error.code === 'validation_failed' ? (save.error.details?.issues as Array<{ path: string; message: string }>) : undefined;
  const branchName = (b: Branch) => pick(b.name_ar ?? b.name, b.name_en ?? b.name);

  return (
    <Drawer open onClose={onClose} title={t('engagement.groups.new')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button disabled={!ok} loading={save.isPending} onClick={() => setConfirm(true)}>{t('actions.create')}</Button>
    </>}>
      {services.isLoading || branches.isLoading ? <LoadingState rows={3} /> : services.error ? <ErrorState error={services.error} /> : (
        <div className="flex flex-col gap-4">
          <FormErrorSummary message={save.error ? msg(save.error) : null} issues={issues} />
          {!groupServices.length ? <Alert tone="warn">{t('engagement.groups.group_services_note')} {t('fe.groups.no_group_services')}</Alert> : null}
          <Field label={t('fe.groups.service')} required hint={t('engagement.groups.group_services_note')}>{(p) => (
            <Select {...p} value={f.service_id} onChange={(e) => { const s = groupServices.find((x) => x.id === e.target.value); set({ service_id: e.target.value, staff_id: s?.staff.length === 1 ? s.staff[0]!.staff_id : '', price: null }); }}>
              <option value="">{t('fe.common.choose')}</option>
              {groupServices.map((s) => <option key={s.id} value={s.id}>{pick(s.name_ar, s.name_en)} — {money(s.price_minor)}</option>)}
            </Select>
          )}</Field>
          <Field label={t('engagement.groups.instructor')} required>{(p) => (
            <Select {...p} value={f.staff_id} disabled={!svc} onChange={(e) => set({ staff_id: e.target.value })}>
              <option value="">{t('fe.common.choose')}</option>
              {(svc?.staff ?? []).filter((s) => s.is_active).map((s) => <option key={s.staff_id} value={s.staff_id}>{s.display_name}</option>)}
            </Select>
          )}</Field>
          {(branches.data?.items.length ?? 0) > 1 ? (
            <Field label={t('fields.branch')} required>{(p) => (
              <Select {...p} value={branchId} onChange={(e) => set({ branch_id: e.target.value })}>
                {branches.data!.items.map((b) => <option key={b.id} value={b.id}>{branchName(b)}</option>)}
              </Select>
            )}</Field>
          ) : null}
          <Field label={t('engagement.groups.start')} required hint={`${t('time.tz_note', { tz })}${svc ? ` · ${formatDuration(svc.duration_min, locale)}` : ''}`}>
            {(p) => <Input {...p} type="datetime-local" value={f.start} onChange={(e) => set({ start: e.target.value })} />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('engagement.groups.capacity')} required>{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={f.capacity} onChange={(e) => set({ capacity: e.target.value.replace(/[^0-9]/g, '') })} />}</Field>
            <Field label={t('fe.groups.price_per_seat')} hint={svc ? t('fe.groups.default_price', { amount: money(svc.price_minor) }) : undefined}>{(p) => <MoneyInput {...p} key={f.service_id} value={f.price} onChange={(m) => set({ price: m })} />}</Field>
          </div>
          <Field label={t('fe.groups.title_ar')} hint={t('fe.groups.title_hint')}>{(p) => <Input {...p} dir="rtl" lang="ar" maxLength={160} value={f.title_ar} onChange={(e) => set({ title_ar: e.target.value })} />}</Field>
          <Field label={t('fe.groups.title_en')} hint={t('fe.groups.title_hint')}>{(p) => <Input {...p} dir="ltr" lang="en" maxLength={160} value={f.title_en} onChange={(e) => set({ title_en: e.target.value })} />}</Field>
          <p className="text-xs text-ink-muted">{t('fe.groups.instructor_blocked')}</p>
        </div>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={t('fe.groups.confirm_title')}
        body={svc && start ? t('fe.groups.confirm_body', { title: f.title_ar || f.title_en || pick(svc.name_ar, svc.name_en), time: start.setLocale('en').toFormat('yyyy-MM-dd HH:mm'), n: capacity }) : null}
        onConfirm={() => { setConfirm(false); save.mutate(); }} />
    </Drawer>
  );
}
