'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { Ban, CalendarClock, CircleCheck, Download, FileText, LogIn, Play, Printer, Undo2, UserX, Wallet, XCircle } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { tzLabel } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select, Textarea } from '../components/form';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { ConfirmDialog, Dialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { ASSIGNED_ACTIONS, BookingStatusBadge, PaymentStatusBadge, useBookingFmt, useFinancialAccess, useLabel, type BookingAction, type BookingStatus } from './common';
import { SlotPicker, type RequestedItem, type SlotOption } from './SlotPicker';

type Item = {
  id: string; sequence: number; service_id: string; variant_id: string | null; staff_id: string; staff_name: string; starts_at: string; ends_at: string;
  service_name_ar: string | null; service_name_en: string | null; duration_min: number; addons: Array<{ id?: string; name_ar?: string | null; name_en?: string | null }>;
  line_total_minor?: number; actual_started_at: string | null; actual_ended_at: string | null; revision: number;
};
type Payment = { id: string; kind: string; method: string; amount_minor: number; status: string; captured_at: string | null; needs_reconciliation: boolean; refunded_or_pending_minor?: number };
type BookingEvent = { id: string; kind: string; from_status: string | null; to_status: string | null; reason: string | null; source: string; actor_role: string | null; created_at: string };
export type BookingDetail = {
  id: string; number: string; status: BookingStatus; starts_at: string; ends_at: string; timezone: string; branch_id: string; source: string; version: number; revision: number;
  hold_expires_at: string | null; customer_note: string | null; internal_note: string | null; cancel_reason: string | null; cancel_source: string | null; cancelled_at: string | null;
  currency: string; payment_status?: string; subtotal_minor?: number; discount_minor?: number; tax_minor?: number; total_minor?: number; paid_minor?: number; refunded_minor?: number; deposit_due_minor?: number;
  policy_snapshot: { no_show_grace_min?: number; tax_label?: string | null } | null;
  items: Item[]; history_items: Item[]; events: BookingEvent[]; payments: Payment[];
  customer: { id: string; display_name: string; phone: string | null; email: string | null; has_account: boolean; private_notes?: string | null } | null;
  available_actions: BookingAction[];
};
type Refund = { id: string; amount_minor: number; status: string; reason: string | null; booking_id: string | null; created_at: string; method: string; requested_by_system: boolean };

const ACTION_ICON: Record<BookingAction, typeof CircleCheck> = { approve: CircleCheck, reject: Ban, check_in: LogIn, start: Play, complete: CircleCheck, no_show: UserX, cancel: XCircle };
const NEEDS_REASON: BookingAction[] = ['cancel', 'reject'];
const DANGER: BookingAction[] = ['cancel', 'reject', 'no_show'];

/** Detail drawer for one booking. Renders only the actions the API allows for its status and the caller's capabilities. */
export function BookingDrawer({ bookingId, onClose }: { bookingId: string; onClose: () => void }) {
  const { t, pick, locale } = useI18n();
  const access = useAccess();
  const { money, when, time } = useBookingFmt();
  const qc = useQueryClient();
  const toast = useToast();
  const financial = useFinancialAccess();
  const label = useLabel();
  const q = useApiQuery<BookingDetail>(['booking', access.slug, bookingId], access.api(`/bookings/${bookingId}`));
  const canRefundList = access.can('refunds.request', 'refunds.approve', 'finance.view');
  const refunds = useApiQuery<Refund[]>(['refunds', access.slug], canRefundList ? access.api('/refunds') : null);
  const [action, setAction] = useState<BookingAction | null>(null);
  const [dialog, setDialog] = useState<'collect' | 'refund' | 'reschedule' | null>(null);

  const writable = !access.readOnly;
  const canManage = writable && access.can('bookings.manage');
  const canAssigned = writable && access.can('bookings.manage_assigned');
  const b = q.data;
  const actions = (b?.available_actions ?? []).filter((a) => canManage || (canAssigned && ASSIGNED_ACTIONS.includes(a)));
  const canReschedule = canManage && !!b && ['confirmed', 'pending_approval'].includes(b.status);
  const balance = b && b.total_minor != null && b.paid_minor != null ? Math.max(0, b.total_minor - b.paid_minor) : 0;
  const canCollect = writable && access.can('payments.collect') && !!b && b.total_minor != null && balance > 0 && !['cancelled', 'expired'].includes(b.status);
  const captured = (b?.payments ?? []).filter((p) => p.status === 'captured');
  const canRefund = writable && access.can('refunds.request') && captured.some((p) => p.amount_minor - (p.refunded_or_pending_minor ?? 0) > 0);
  const bookingRefunds = (refunds.data ?? []).filter((r) => r.booking_id === bookingId);

  const refresh = async () => {
    await q.refetch();
    qc.invalidateQueries({ queryKey: ['bookings', access.slug] });
    qc.invalidateQueries({ queryKey: ['refunds', access.slug] });
    qc.invalidateQueries({ queryKey: ['portal', access.slug] });
  };

  const tz = b?.timezone ?? access.timezone;
  const now = DateTime.now().setZone(tz);
  const isServiceDay = b ? DateTime.fromISO(b.starts_at, { zone: tz }).hasSame(now, 'day') : false;
  const noShowAt = b ? DateTime.fromISO(b.starts_at).plus({ minutes: b.policy_snapshot?.no_show_grace_min ?? 15 }) : null;
  const blockedReason = (a: BookingAction) => {
    if ((a === 'check_in' || a === 'start') && !isServiceDay) return t('bookings_ui.detail.only_service_day');
    if (a === 'no_show' && noShowAt && DateTime.now() < noShowAt) return t('bookings_ui.detail.no_show_after', { time: time(noShowAt.toISO()!, tz) });
    return null;
  };

  return (
    <Drawer open onClose={onClose} wide title={b ? <span dir="ltr">{b.number}</span> : t('booking.dashboard.title')}
      footer={b && (actions.length || canReschedule) ? (
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {actions.filter((a) => DANGER.includes(a)).map((a) => {
            const Icon = ACTION_ICON[a];
            return <Button key={a} size="sm" variant="ghost" icon={<Icon className="size-4" />} disabled={!!blockedReason(a)} title={blockedReason(a) ?? undefined} onClick={() => setAction(a)}>{t(`booking.actions.${a}`)}</Button>;
          })}
          {canReschedule ? <Button size="sm" variant="outline" icon={<CalendarClock className="size-4" />} onClick={() => setDialog('reschedule')}>{t('booking.actions.reschedule')}</Button> : null}
          {actions.filter((a) => !DANGER.includes(a)).map((a, i) => {
            const Icon = ACTION_ICON[a];
            return <Button key={a} size="sm" variant={i === 0 ? 'primary' : 'outline'} icon={<Icon className="size-4" />} disabled={!!blockedReason(a)} title={blockedReason(a) ?? undefined} onClick={() => setAction(a)}>{t(`booking.actions.${a}`)}</Button>;
          })}
        </div>
      ) : undefined}>
      {q.isLoading ? <LoadingState rows={5} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : b ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <BookingStatusBadge status={b.status} />
            {financial ? <PaymentStatusBadge status={b.payment_status} /> : null}
            <Badge>{label(`bookings_ui.source.${b.source}`, b.source)}</Badge>
          </div>
          {['held', 'pending_payment'].includes(b.status) && b.hold_expires_at ? <Alert tone="warn">{t('bookings_ui.detail.hold_until', { time: when(b.hold_expires_at, tz) })}</Alert> : null}
          {b.status === 'pending_approval' ? <Alert tone="info">{t('bookings_ui.detail.needs_approval')}</Alert> : null}
          {b.status === 'cancelled' && b.cancel_reason ? <Alert tone="danger" title={t('bookings_ui.detail.cancelled_by', { who: t(`bookings_ui.cancel_source.${b.cancel_source ?? 'business'}`) })}>{b.cancel_reason}</Alert> : null}
          {actions.map(blockedReason).filter(Boolean).length ? <p className="text-xs text-ink-muted">{[...new Set(actions.map(blockedReason).filter(Boolean))].join(' · ')}</p> : null}

          <section>
            <h3 className="mb-1 text-sm font-semibold">{t('booking.dashboard.when')}</h3>
            <p>{when(b.starts_at, tz)} – <bdi>{time(b.ends_at, tz)}</bdi></p>
            <p className="text-xs text-ink-muted">{t('time.tz_note', { tz: tzLabel(tz, locale) })}</p>
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold">{t('booking.dashboard.customer')}</h3>
            {b.customer ? (
              <>
                <p className="font-medium">{b.customer.display_name}{b.customer.has_account ? <Badge className="ms-2">{t('bookings_ui.detail.has_account')}</Badge> : null}</p>
                {access.can('customers.view') && (b.customer.phone || b.customer.email) ? <p className="text-sm text-ink-muted" dir="ltr">{[b.customer.phone, b.customer.email].filter(Boolean).join(' · ')}</p> : null}
                {b.customer.private_notes ? <p className="mt-1 rounded-lg bg-luma-50 p-2 text-sm"><span className="font-medium">{t('bookings_ui.detail.customer_private')}: </span>{b.customer.private_notes}</p> : null}
              </>
            ) : <p className="text-sm text-ink-muted">{t('states.unknown')}</p>}
            {b.customer_note ? <p className="mt-2 rounded-lg bg-luma-50 p-2 text-sm"><span className="font-medium">{t('booking.dashboard.customer_note')}: </span>{b.customer_note}</p> : null}
            {b.internal_note ? <p className="mt-2 rounded-lg bg-warn-bg p-2 text-sm"><span className="font-medium">{t('booking.dashboard.internal_note')}: </span>{b.internal_note}</p> : null}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('booking.dashboard.items')}</h3>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {b.items.map((i) => (
                <li key={i.id} className="flex items-start justify-between gap-3 p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{pick(i.service_name_ar, i.service_name_en)}</p>
                    <p className="text-xs text-ink-muted"><bdi>{i.staff_name}</bdi> · <bdi>{time(i.starts_at, tz)} – {time(i.ends_at, tz)}</bdi> · <bdi>{t('bookings_ui.detail.minutes', { n: i.duration_min })}</bdi></p>
                    {i.addons?.length ? <p className="text-xs text-ink-muted">+ {i.addons.map((a) => pick(a.name_ar, a.name_en)).join('، ')}</p> : null}
                  </div>
                  {financial && i.line_total_minor != null ? <span dir="ltr" className="shrink-0 font-medium">{money(i.line_total_minor)}</span> : null}
                </li>
              ))}
            </ul>
            {financial && b.total_minor != null ? (
              <dl className="mt-3 flex flex-col gap-1 text-sm">
                {b.subtotal_minor != null ? <Row label={t('commerce.orders.subtotal')} value={money(b.subtotal_minor)} /> : null}
                {b.discount_minor ? <Row label={t('commerce.orders.discount')} value={`−${money(b.discount_minor)}`} /> : null}
                {b.tax_minor ? <Row label={b.policy_snapshot?.tax_label || t('booking.checkout.tax')} value={money(b.tax_minor)} /> : null}
                <div className="flex justify-between border-t border-line pt-1 font-semibold"><dt>{t('fields.total')}</dt><dd dir="ltr">{money(b.total_minor)}</dd></div>
                {b.deposit_due_minor ? <Row muted label={t('bookings_ui.detail.deposit_due')} value={money(b.deposit_due_minor)} /> : null}
                <Row muted label={t('booking.checkout.paid')} value={money(b.paid_minor)} />
                {b.refunded_minor ? <Row muted label={t('commerce.orders.refunded')} value={money(b.refunded_minor)} /> : null}
                <Row label={t('bookings_ui.detail.balance')} value={money(balance)} strong={balance > 0} />
              </dl>
            ) : null}
          </section>

          {financial ? (
            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t('booking.dashboard.payments')}</h3>
                <div className="flex flex-wrap gap-2">
                  {canCollect ? <Button size="sm" icon={<Wallet className="size-4" />} onClick={() => setDialog('collect')}>{t('booking.actions.collect')}</Button> : null}
                  {canRefund ? <Button size="sm" variant="outline" icon={<Undo2 className="size-4" />} onClick={() => setDialog('refund')}>{t('booking.actions.refund')}</Button> : null}
                </div>
              </div>
              {b.payments.length ? (
                <ul className="flex flex-col gap-2 text-sm">
                  {b.payments.map((p) => <PaymentLine key={p.id} p={p} tz={tz} />)}
                </ul>
              ) : <p className="text-sm text-ink-muted">{t('commerce.orders.no_payments')}</p>}
              {canRefundList ? (
                refunds.isLoading ? <LoadingState rows={1} /> : refunds.error ? <ErrorState error={refunds.error} onRetry={() => refunds.refetch()} /> : bookingRefunds.length ? (
                  <div className="mt-3">
                    <h4 className="mb-1 text-xs font-semibold text-ink-muted">{t('bookings_ui.refund.list')}</h4>
                    <ul className="flex flex-col gap-2">{bookingRefunds.map((r) => <RefundLine key={r.id} r={r} onDone={refresh} />)}</ul>
                  </div>
                ) : null
              ) : null}
              <Documents booking={b} />
            </section>
          ) : null}

          {b.events.length ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold">{t('booking.dashboard.history')}</h3>
              <ol className="flex flex-col gap-2 border-s-2 border-luma-100 ps-4">
                {b.events.map((e) => (
                  <li key={e.id} className="text-sm">
                    <p className="font-medium">{eventLabel(t, e)}</p>
                    <p className="text-xs text-ink-muted">{when(e.created_at, tz)} · {label(`bookings_ui.event_source.${e.source}`, e.source)}{e.source === 'staff' && e.actor_role ? ` (${label(`roles.${e.actor_role}`, e.actor_role)})` : ''}</p>
                    {e.reason ? <p className="text-xs">{label(`bookings_ui.reason.${e.reason}`, e.reason)}</p> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
      ) : null}

      {action && b ? <ActionDialog booking={b} action={action} onClose={() => setAction(null)} onDone={async (r) => {
        setAction(null);
        toast({ tone: 'ok', text: r?.refund_due_minor && financial ? t('bookings_ui.detail.done_refund', { amount: money(r.refund_due_minor) }) : t('bookings_ui.detail.done') });
        await refresh();
      }} /> : null}
      {dialog === 'collect' && b ? <CollectDialog booking={b} balance={balance} onClose={() => setDialog(null)} onDone={async () => { setDialog(null); toast({ tone: 'ok', text: t('bookings_ui.collect.done') }); await refresh(); }} /> : null}
      {dialog === 'refund' && b ? <RefundDialog booking={b} payments={captured} onClose={() => setDialog(null)} onDone={async (status) => { setDialog(null); toast({ tone: 'ok', text: status === 'requested' ? t('bookings_ui.refund.requested') : t('bookings_ui.refund.sent') }); await refresh(); }} /> : null}
      {dialog === 'reschedule' && b ? <RescheduleDialog booking={b} onClose={() => setDialog(null)} onDone={async () => { setDialog(null); toast({ tone: 'ok', text: t('bookings_ui.reschedule.done') }); await refresh(); }} /> : null}
    </Drawer>
  );
}

function Row({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return <div className={`flex justify-between ${muted ? 'text-ink-muted' : ''} ${strong ? 'font-semibold text-luma-900' : ''}`}><dt>{label}</dt><dd dir="ltr">{value}</dd></div>;
}

function eventLabel(t: (k: string, v?: Record<string, string | number>) => string, e: BookingEvent) {
  if (e.kind === 'created') return t('bookings_ui.event.created');
  if (e.kind === 'rescheduled') return t('bookings_ui.event.rescheduled');
  return e.to_status ? t('bookings_ui.event.status', { status: t(`booking.status.${e.to_status}`) }) : e.kind;
}

function PaymentLine({ p, tz }: { p: Payment; tz: string }) {
  const { t } = useI18n();
  const { money, when } = useBookingFmt();
  const label = useLabel();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-2">
      <span className="flex flex-wrap items-center gap-1.5">
        <span>{label(`bookings_ui.method.${p.method}`, p.method)}</span>
        <Badge tone={p.status === 'captured' ? 'ok' : p.status === 'failed' ? 'danger' : 'neutral'}>{label(`bookings_ui.payment.${p.status}`, p.status)}</Badge>
        {p.kind === 'deposit' ? <Badge>{t('bookings_ui.payment.deposit')}</Badge> : null}
        {p.needs_reconciliation ? <Badge tone="warn">{t('bookings_ui.payment.reconcile')}</Badge> : null}
        {p.captured_at ? <span className="text-xs text-ink-muted">{when(p.captured_at, tz)}</span> : null}
      </span>
      <span dir="ltr" className="font-medium">{money(p.amount_minor)}{p.refunded_or_pending_minor ? <span className="ms-1 text-xs text-ink-muted">(−{money(p.refunded_or_pending_minor)})</span> : null}</span>
    </li>
  );
}

function RefundLine({ r, onDone }: { r: Refund; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const access = useAccess();
  const { money, when } = useBookingFmt();
  const label = useLabel();
  const msg = useErrorMessage();
  const [confirm, setConfirm] = useState(false);
  const approve = useApiMutation(() => api(access.api(`/refunds/${r.id}/approve`), { method: 'POST' }), { onSuccess: async () => { setConfirm(false); await onDone(); } });
  return (
    <li className="rounded-lg border border-line p-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn'}>{label(`bookings_ui.refund.status.${r.status}`, r.status)}</Badge>
          <span className="text-xs text-ink-muted">{when(r.created_at)}</span>
          {r.requested_by_system ? <Badge>{t('bookings_ui.refund.by_policy')}</Badge> : null}
        </span>
        <span dir="ltr" className="font-medium">{money(r.amount_minor)}</span>
      </div>
      {r.reason ? <p className="mt-1 text-xs">{r.reason}</p> : null}
      {r.status === 'requested' && access.can('refunds.approve') && !access.readOnly ? (
        <div className="mt-2 flex justify-end"><Button size="sm" onClick={() => setConfirm(true)}>{t('bookings_ui.refund.approve')}</Button></div>
      ) : null}
      {approve.error ? <p className="mt-1 text-xs text-danger" role="alert">{msg(approve.error)}</p> : null}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} loading={approve.isPending} title={t('bookings_ui.refund.approve_title', { amount: money(r.amount_minor) })}
        body={t('bookings_ui.refund.approve_body')} confirmLabel={t('bookings_ui.refund.approve')} onConfirm={() => approve.mutate(undefined)} />
    </li>
  );
}

function ActionDialog({ booking, action, onClose, onDone }: { booking: BookingDetail; action: BookingAction; onClose: () => void; onDone: (r: { refund_due_minor?: number } | undefined) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [reason, setReason] = useState('');
  const m = useApiMutation((vars: { reason?: string }) => api<{ refund_due_minor?: number }>(access.api(`/bookings/${booking.id}/transition`), { body: { action, version: booking.version, ...vars } }), { onSuccess: (r) => onDone(r) });
  const needsReason = NEEDS_REASON.includes(action);
  const label = t(`booking.actions.${action}`);
  const body = (
    <div className="flex flex-col gap-3">
      <FormErrorSummary message={m.error ? msg(m.error) : null} />
      <p className="text-ink-muted">{t(`bookings_ui.confirm.${action}`, { number: booking.number })}</p>
      {needsReason ? <Field label={t('booking.dashboard.reason')} required hint={t('bookings_ui.detail.reason_hint')}>{(p) => <Textarea {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Field> : null}
    </div>
  );
  if (!needsReason) {
    return <ConfirmDialog open onClose={onClose} loading={m.isPending} danger={DANGER.includes(action)} title={t('bookings_ui.confirm.title', { action: label })} body={body} confirmLabel={label} onConfirm={() => m.mutate({})} />;
  }
  return (
    <Dialog open onClose={onClose} title={t('bookings_ui.confirm.title', { action: label })} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.back')}</Button>
      <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate({ reason: reason.trim() })}>{label}</Button>
    </>}>{body}</Dialog>
  );
}

function CollectDialog({ booking, balance, onClose, onDone }: { booking: BookingDetail; balance: number; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { money } = useBookingFmt();
  const [amount, setAmount] = useState<number | null>(balance);
  const [method, setMethod] = useState<'cash' | 'pos_terminal'>('cash');
  const [reference, setReference] = useState('');
  const m = useApiMutation((_: void, { idempotencyKey }) => api(access.api('/payments/on-site'), { body: { booking_id: booking.id, amount_minor: amount, method, reference: reference.trim() }, idempotencyKey }), { onSuccess: () => onDone() });
  const invalidAmount = amount == null || amount <= 0 || amount > balance;
  return (
    <Dialog open onClose={onClose} title={t('booking.dashboard.collect_title')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button loading={m.isPending} disabled={invalidAmount || reference.trim().length < 2} onClick={() => m.mutate()}>{t('booking.actions.collect')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={m.error ? msg(m.error) : null} />
        <p className="text-ink-muted">{t('bookings_ui.collect.balance', { amount: money(balance) })}</p>
        <Field label={t('booking.dashboard.amount')} required error={amount != null && amount > balance ? t('errors.amount_exceeds_due') : null}>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
        <Field label={t('booking.dashboard.method')} required>{(p) => (
          <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'pos_terminal')}>
            <option value="cash">{t('booking.dashboard.cash')}</option>
            <option value="pos_terminal">{t('booking.dashboard.pos')}</option>
          </Select>
        )}</Field>
        <Field label={t('booking.dashboard.reference')} required hint={t('bookings_ui.collect.reference_hint')}>{(p) => <Input {...p} dir="ltr" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

function RefundDialog({ booking, payments, onClose, onDone }: { booking: BookingDetail; payments: Payment[]; onClose: () => void; onDone: (status: string) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { money } = useBookingFmt();
  const label = useLabel();
  const refundableOf = (p: Payment) => Math.max(0, p.amount_minor - (p.refunded_or_pending_minor ?? 0));
  const usable = payments.filter((p) => refundableOf(p) > 0);
  const [paymentId, setPaymentId] = useState(usable[0]?.id ?? '');
  const payment = usable.find((p) => p.id === paymentId);
  const max = payment ? refundableOf(payment) : 0;
  const [amount, setAmount] = useState<number | null>(max || null);
  const [reason, setReason] = useState('');
  const m = useApiMutation((_: void, { idempotencyKey }) => api<{ id: string; status: string }>(access.api('/refunds'), { body: { payment_id: paymentId, amount_minor: amount, reason: reason.trim() }, idempotencyKey }), { onSuccess: (r) => onDone(r.status) });
  const autoApproved = access.can('refunds.approve');
  return (
    <Dialog open onClose={onClose} title={t('booking.dashboard.refund_title')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button variant="danger" loading={m.isPending} disabled={!payment || amount == null || amount <= 0 || amount > max || reason.trim().length < 3} onClick={() => m.mutate()}>{autoApproved ? t('bookings_ui.refund.submit_approved') : t('bookings_ui.refund.submit')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={m.error ? msg(m.error) : null} />
        {!usable.length ? <Alert tone="info">{t('bookings_ui.refund.nothing')}</Alert> : (
          <>
            <Field label={t('bookings_ui.refund.payment')} required>{(p) => (
              <Select {...p} value={paymentId} onChange={(e) => { setPaymentId(e.target.value); const np = usable.find((x) => x.id === e.target.value); setAmount(np ? refundableOf(np) : null); }}>
                {usable.map((x) => <option key={x.id} value={x.id}>{`${label(`bookings_ui.method.${x.method}`, x.method)} · ${money(x.amount_minor)}`}</option>)}
              </Select>
            )}</Field>
            <p className="text-ink-muted">{t('bookings_ui.refund.refundable', { amount: money(max) })}</p>
            <Field label={t('booking.dashboard.refund_amount')} required error={amount != null && amount > max ? t('errors.refund_exceeds_payment') : null}>{(p) => <MoneyInput key={paymentId} {...p} value={amount} onChange={setAmount} />}</Field>
            <Field label={t('booking.dashboard.reason')} required>{(p) => <Textarea {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Field>
            <p className="text-xs text-ink-muted">{autoApproved ? t('bookings_ui.refund.note_approver') : t('bookings_ui.refund.note_request')}</p>
          </>
        )}
        <span className="sr-only">{booking.number}</span>
      </div>
    </Dialog>
  );
}

function RescheduleDialog({ booking, onClose, onDone }: { booking: BookingDetail; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { money } = useBookingFmt();
  const [keepStaff, setKeepStaff] = useState(true);
  const items: RequestedItem[] = booking.items.map((i) => ({
    key: `i${i.sequence}`, service_id: i.service_id, variant_id: i.variant_id,
    addon_ids: (i.addons ?? []).map((a) => a.id).filter((x): x is string => !!x), staff_id: keepStaff ? i.staff_id : null,
  }));
  const [slot, setSlot] = useState<SlotOption | null>(null);
  const [priceChange, setPriceChange] = useState<{ old: number; next: number } | null>(null);
  const m = useApiMutation((accept: number | undefined) => api(access.api(`/bookings/${booking.id}/reschedule`), {
    body: { items: items.map((it) => ({ ...it, staff_id: slot!.items.find((x) => x.key === it.key)!.staff_id, start: slot!.items.find((x) => x.key === it.key)!.start })), ...(accept != null ? { accept_total_minor: accept } : {}) },
  }), {
    onSuccess: () => onDone(),
  });
  const submit = (accept?: number) => m.mutate(accept, {
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'price_changed' && e.details) setPriceChange({ old: Number(e.details.old_total_minor), next: Number(e.details.new_total_minor) });
      if (e instanceof ApiError && e.code === 'slot_unavailable') setSlot(null);
    },
  });
  return (
    <Dialog open onClose={onClose} title={t('booking.dashboard.reschedule_title')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      {priceChange ? <Button loading={m.isPending} disabled={!slot} onClick={() => submit(priceChange.next)}>{t('bookings_ui.reschedule.accept_price')}</Button>
        : <Button loading={m.isPending} disabled={!slot} onClick={() => submit()}>{t('bookings_ui.reschedule.submit')}</Button>}
    </>}>
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto">
        <FormErrorSummary message={m.error && !(m.error instanceof ApiError && m.error.code === 'price_changed') ? msg(m.error) : null} />
        <p className="text-ink-muted">{t('bookings_ui.reschedule.intro')}</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-luma-700" checked={keepStaff} onChange={(e) => { setKeepStaff(e.target.checked); setSlot(null); setPriceChange(null); }} />
          {t('bookings_ui.reschedule.keep_staff')}
        </label>
        <SlotPicker branchId={booking.branch_id} items={items} timezone={booking.timezone} value={slot} onChange={(o) => { setSlot(o); setPriceChange(null); m.reset(); }} />
        {priceChange ? <Alert tone="warn">{t('booking.dashboard.price_changed', { new: money(priceChange.next), old: money(priceChange.old) })}</Alert> : null}
      </div>
    </Dialog>
  );
}

/** Receipts (per captured payment) and the invoice (completed bookings), issued on demand and downloaded through the authorised PDF route. */
function Documents({ booking }: { booking: BookingDetail }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [docs, setDocs] = useState<Record<string, string>>({});
  const canReceipt = access.can('finance.view', 'payments.collect') && !access.readOnly;
  const canInvoice = access.can('finance.view') && !access.readOnly && booking.status === 'completed';
  const receipt = useApiMutation((paymentId: string) => api<{ id: string }>(access.api('/finance/receipts'), { body: { payment_id: paymentId } }), { onSuccess: (r, pid) => setDocs((d) => ({ ...d, [pid]: r.id })) });
  const invoice = useApiMutation(() => api<{ id: string }>(access.api('/finance/invoices'), { body: { booking_id: booking.id } }), { onSuccess: (r) => setDocs((d) => ({ ...d, invoice: r.id })) });
  const captured = booking.payments.filter((p) => p.status === 'captured');
  if (!(canReceipt && captured.length) && !canInvoice) return null;
  const links = (id: string) => (
    <span className="flex flex-wrap gap-2">
      <a className="inline-flex items-center gap-1 text-sm text-luma-800 underline" href={access.api(`/finance/invoices/${id}/pdf`)} target="_blank" rel="noopener"><Download className="size-4" aria-hidden />{t('bookings_ui.docs.pdf')}</a>
      <a className="inline-flex items-center gap-1 text-sm text-luma-800 underline" href={access.api(`/finance/invoices/${id}/pdf?format=html`)} target="_blank" rel="noopener"><Printer className="size-4" aria-hidden />{t('bookings_ui.docs.print')}</a>
    </span>
  );
  return (
    <div className="mt-4 rounded-xl border border-line p-3">
      <h4 className="mb-2 flex items-center gap-1 text-sm font-semibold"><FileText className="size-4" aria-hidden />{t('bookings_ui.docs.title')}</h4>
      <ul className="flex flex-col gap-2 text-sm">
        {canReceipt ? captured.map((p, i) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('bookings_ui.docs.receipt_n', { n: i + 1 })}</span>
            {docs[p.id] ? links(docs[p.id]!) : <Button size="sm" variant="outline" loading={receipt.isPending && receipt.variables === p.id} onClick={() => receipt.mutate(p.id)}>{t('bookings_ui.docs.issue_receipt')}</Button>}
          </li>
        )) : null}
        {canInvoice ? (
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('booking.actions.invoice')}</span>
            {docs.invoice ? links(docs.invoice) : <Button size="sm" variant="outline" loading={invoice.isPending} onClick={() => invoice.mutate(undefined)}>{t('bookings_ui.docs.issue_invoice')}</Button>}
          </li>
        ) : null}
      </ul>
      <p className="mt-2 text-xs text-ink-muted">{t('bookings_ui.docs.note')}</p>
      {receipt.error || invoice.error ? <p className="mt-1 text-xs text-danger" role="alert">{msg(receipt.error ?? invoice.error)}</p> : null}
    </div>
  );
}
