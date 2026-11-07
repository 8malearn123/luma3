'use client';

import { useState } from 'react';
import { ArrowLeftRight, CalendarClock, Plus, XCircle } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { Dialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { localToIso, todayIn } from '../catalog/common';
import { useDay, useDays, type Balance } from './common';

/** Annual leave balances of the team (approvers), with the owner's adjustment. */
export function LeaveBalancesCard() {
  const { t } = useI18n();
  const access = useAccess();
  const days = useDays();
  const day = useDay();
  const q = useApiQuery<Balance[]>(['hr-balances', access.slug], access.api('/hr/balances'));
  const canAdjust = access.can('hr.configure') && !access.readOnly;
  const [adjust, setAdjust] = useState<Balance | null>(null);
  return (
    <Card title={t('hr.balance.team_title')}>
      {q.isLoading ? <LoadingState rows={2} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <EmptyState title={t('states.empty')} /> : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">{t('hr.balance.team_title')}</caption>
            <thead><tr className="text-start text-xs text-ink-muted">
              <th className="px-1 py-1 text-start font-medium">{t('hr.balance.staff')}</th>
              <th className="px-1 py-1 text-start font-medium">{t('hr.balance.hire_date')}</th>
              <th className="px-1 py-1 text-start font-medium">{t('hr.balance.accrued')}</th>
              <th className="px-1 py-1 text-start font-medium">{t('hr.balance.taken')}</th>
              <th className="px-1 py-1 text-start font-medium">{t('hr.balance.balance')}</th>
              <th className="hidden px-1 py-1 text-start font-medium sm:table-cell">{t('hr.balance.sick')}</th>
              {canAdjust ? <th className="px-1 py-1" /> : null}
            </tr></thead>
            <tbody>
              {q.data.map((b) => (
                <tr key={b.staff_id} className="border-t border-line">
                  <td className="px-1 py-2 font-medium">{b.staff_name}</td>
                  <td className="px-1 py-2">{b.hire_date ? day(b.hire_date) : <span className="text-xs text-ink-muted">{t('hr.balance.no_hire_date')}</span>}</td>
                  <td className="px-1 py-2">{days(b.accrued)}</td>
                  <td className="px-1 py-2">{days(b.taken)}{b.pending ? <span className="block text-[11px] text-ink-muted">{t('hr.balance.pending_n', { n: days(b.pending) })}</span> : null}</td>
                  <td className="px-1 py-2">{b.balance == null ? '—' : <Badge tone={b.balance > 0 ? 'ok' : 'warn'}>{t('hr.balance.days', { n: days(b.balance) })}</Badge>}</td>
                  <td className="hidden px-1 py-2 sm:table-cell">{days(b.sick_taken_year)}</td>
                  {canAdjust ? <td className="px-1 py-2 text-end"><Button size="sm" variant="ghost" onClick={() => setAdjust(b)}>{t('hr.balance.adjust')}</Button></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-muted">{t('hr.balance.rule')}</p>
        </div>
      )}
      {adjust ? <AdjustDialog row={adjust} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); q.refetch(); }} /> : null}
    </Card>
  );
}

function AdjustDialog({ row, onClose, onDone }: { row: Balance; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const [daysStr, setDays] = useState('');
  const [note, setNote] = useState('');
  const n = Number(daysStr.replace(',', '.'));
  const valid = daysStr.trim() !== '' && Number.isFinite(n) && n !== 0 && Math.abs(n) <= 365 && note.trim().length >= 3;
  const m = useApiMutation(() => api(access.api(`/hr/balances/${row.staff_id}`), { body: { days: Math.round(n * 100) / 100, note: note.trim() } }), {
    invalidate: [['hr-balances', access.slug]], onSuccess: () => { toast({ tone: 'ok', text: t('hr.balance.adjusted') }); onDone(); },
  });
  return (
    <Dialog open onClose={onClose} title={t('hr.balance.adjust_title', { name: row.staff_name ?? '' })} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button disabled={!valid} loading={m.isPending} onClick={() => m.mutate(undefined)}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={m.error ? msg(m.error) : null} />
        <Field label={t('hr.balance.adjust_days')} hint={t('hr.balance.adjust_hint')} required>{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={daysStr} onChange={(e) => setDays(e.target.value)} />}</Field>
        <Field label={t('hr.balance.adjust_note')} required>{(p) => <Textarea {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

/** A staff member's own balance line, shown in leave request forms. */
export function OwnBalanceNote({ staffId }: { staffId?: string | null }) {
  const { t } = useI18n();
  const access = useAccess();
  const days = useDays();
  const id = staffId ?? access.staffProfileId;
  const q = useApiQuery<Balance[]>(['hr-balances', access.slug, id], id ? access.api(`/hr/balances?staff_id=${id}`) : null);
  const b = q.data?.[0];
  if (!b) return null;
  if (b.balance == null) return <p className="text-xs text-ink-muted">{t('hr.balance.unknown')}</p>;
  return (
    <p className="rounded-lg bg-luma-50 px-3 py-2 text-xs">
      {t('hr.balance.line', { balance: days(b.balance), entitlement: b.yearly_entitlement })}
      {b.pending ? ` · ${t('hr.balance.pending_n', { n: days(b.pending) })}` : ''}
    </p>
  );
}

type RerouteData = {
  leave_id: string; staff_id: string;
  bookings: Array<{ booking_id: string; number: string; status: string; starts_at: string; ends_at: string; timezone: string; customer_name: string; total_minor: number;
    services: Array<{ name_ar: string | null; name_en: string | null; starts_at: string }>; candidates: Array<{ staff_id: string; staff_name: string; same_price: boolean }>; suggested_staff_id: string | null }>;
  log: Array<{ id: string; booking_id: string; number: string; action: string; to_staff_name: string | null; to_starts_at: string | null; note: string | null; created_at: string }>;
};

/**
 * Bookings affected by an approved leave: one-click reassignment to the
 * suggested colleague, or a new time, or cancellation with the customer notified.
 */
export function RerouteDrawer({ leaveId, onClose }: { leaveId: string; onClose: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { when } = useFmt();
  const q = useApiQuery<RerouteData>(['hr-reroute', access.slug, leaveId], access.api(`/hr/leave/${leaveId}/reroutes`));
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  return (
    <Drawer open onClose={onClose} title={t('hr.reroute.title')} wide>
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">{t('hr.reroute.intro')}</p>
          {!q.data.bookings.length ? <Alert tone="ok">{t('hr.reroute.all_done')}</Alert> : (
            <ul className="flex flex-col gap-3">
              {q.data.bookings.map((b) => (
                <li key={b.booking_id} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{when(b.starts_at)}</span>
                    <span dir="ltr" className="text-xs text-ink-muted">{b.number}</span>
                  </div>
                  <p className="text-sm">{b.customer_name} · {b.services.map((s) => pick(s.name_ar, s.name_en)).join(' + ')}</p>
                  {b.candidates.length ? (
                    <div className="mt-2 flex flex-col gap-2">
                      {b.candidates.map((c, i) => <ReassignRow key={c.staff_id} leaveId={leaveId} bookingId={b.booking_id} candidate={c} primary={i === 0} onDone={() => q.refetch()} />)}
                    </div>
                  ) : <Alert tone="warn" className="mt-2">{t('hr.reroute.no_colleague')}</Alert>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" icon={<CalendarClock className="size-4" />} onClick={() => setMoveFor(b.booking_id)}>{t('hr.reroute.reschedule')}</Button>
                    <Button size="sm" variant="ghost" icon={<XCircle className="size-4" />} onClick={() => setCancelFor(b.booking_id)}>{t('hr.reroute.cancel')}</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {q.data.log.length ? (
            <div>
              <h3 className="mb-1 text-sm font-semibold">{t('hr.reroute.log')}</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {q.data.log.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-2">
                    <span dir="ltr" className="text-xs text-ink-muted">{l.number}</span>
                    <Badge tone={l.action === 'cancelled' ? 'danger' : 'ok'}>{t(`hr.reroute.actions.${l.action}`)}</Badge>
                    {l.to_staff_name ? <span>{l.to_staff_name}</span> : null}
                    {l.action === 'rescheduled' && l.to_starts_at ? <span>{when(l.to_starts_at)}</span> : null}
                    {l.note ? <span className="text-xs text-ink-muted">{l.note}</span> : null}
                    <span className="ms-auto text-xs text-ink-muted">{when(l.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {cancelFor ? <CancelBookingDialog leaveId={leaveId} bookingId={cancelFor} onClose={() => setCancelFor(null)} onDone={() => { setCancelFor(null); q.refetch(); }} /> : null}
      {moveFor && q.data ? <MoveDialog leaveId={leaveId} booking={q.data.bookings.find((b) => b.booking_id === moveFor)!} onClose={() => setMoveFor(null)} onDone={() => { setMoveFor(null); q.refetch(); }} /> : null}
    </Drawer>
  );
}

function ReassignRow({ leaveId, bookingId, candidate, primary, onDone }: { leaveId: string; bookingId: string; candidate: { staff_id: string; staff_name: string; same_price: boolean }; primary: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const { money } = useFmt();
  const [accept, setAccept] = useState<number | null>(null);
  const m = useApiMutation((total: number | null) => api(access.api(`/hr/leave/${leaveId}/reroutes`), { body: { action: 'reassign', booking_id: bookingId, to_staff_id: candidate.staff_id, ...(total != null ? { accept_total_minor: total } : {}) } }), {
    invalidate: [['bookings', access.slug]], onSuccess: () => { toast({ tone: 'ok', text: t('hr.reroute.reassigned', { name: candidate.staff_name }) }); onDone(); },
  });
  const priceChange = m.error?.code === 'price_changed' ? (m.error.details?.new_total_minor as number | undefined) : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-luma-50 px-3 py-2 text-sm">
      <ArrowLeftRight className="size-4 text-luma-700" aria-hidden />
      <span>{primary ? t('hr.reroute.suggested', { name: candidate.staff_name }) : candidate.staff_name}</span>
      {!candidate.same_price ? <Badge tone="warn">{t('hr.reroute.price_differs')}</Badge> : null}
      <Button size="sm" className="ms-auto" variant={primary ? 'primary' : 'outline'} loading={m.isPending} onClick={() => m.mutate(accept)}>{t('hr.reroute.approve')}</Button>
      {priceChange != null && accept == null ? (
        <p className="w-full text-xs text-warn">{t('hr.reroute.confirm_price', { amount: money(priceChange) })} <button type="button" className="font-medium underline" onClick={() => { setAccept(priceChange); m.mutate(priceChange); }}>{t('actions.confirm')}</button></p>
      ) : m.error ? <p className="w-full text-xs text-danger">{msg(m.error)}</p> : null}
    </div>
  );
}

function CancelBookingDialog({ leaveId, bookingId, onClose, onDone }: { leaveId: string; bookingId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [reason, setReason] = useState(t('hr.reroute.default_reason'));
  const m = useApiMutation(() => api(access.api(`/hr/leave/${leaveId}/reroutes`), { body: { action: 'cancel', booking_id: bookingId, reason: reason.trim() } }), {
    invalidate: [['bookings', access.slug]], onSuccess: () => onDone(),
  });
  return (
    <Dialog open onClose={onClose} title={t('hr.reroute.cancel_title')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button variant="danger" disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate(undefined)}>{t('hr.reroute.cancel')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={m.error ? msg(m.error) : null} />
        <p className="text-ink-muted">{t('hr.reroute.cancel_body')}</p>
        <Field label={t('fields.reason')} required>{(p) => <Textarea {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

function MoveDialog({ leaveId, booking, onClose, onDone }: { leaveId: string; booking: RerouteData['bookings'][number]; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const staff = useApiQuery<Array<{ id: string; display_name: string; is_active: boolean }>>(['staff', access.slug], access.api('/staff'));
  const [local, setLocal] = useState(`${todayIn(access.timezone, 7)}T10:00`);
  const [staffId, setStaffId] = useState('');
  const iso = localToIso(local, access.timezone);
  const m = useApiMutation(() => api(access.api(`/hr/leave/${leaveId}/reroutes`), { body: { action: 'reschedule', booking_id: booking.booking_id, start: iso, ...(staffId ? { staff_id: staffId } : {}) } }), {
    invalidate: [['bookings', access.slug]], onSuccess: () => onDone(),
  });
  return (
    <Dialog open onClose={onClose} title={t('hr.reroute.reschedule_title')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button icon={<Plus className="size-4" />} disabled={!iso} loading={m.isPending} onClick={() => m.mutate(undefined)}>{t('hr.reroute.reschedule')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={m.error ? msg(m.error) : null} />
        <p className="text-ink-muted">{t('hr.reroute.reschedule_body')}</p>
        <Field label={t('hr.reroute.new_time')} required>{(p) => <Input {...p} type="datetime-local" dir="ltr" value={local} onChange={(e) => setLocal(e.target.value)} />}</Field>
        <Field label={t('hr.reroute.with_staff')} hint={t('hr.reroute.with_staff_hint')}>{(p) => (
          <Select {...p} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">{t('hr.reroute.same_staff')}</option>
            {(staff.data ?? []).filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
          </Select>
        )}</Field>
      </div>
    </Dialog>
  );
}
