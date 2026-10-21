'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { ArrowLeft, ArrowRight, CalendarClock, CreditCard, ExternalLink, FileText, Store } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney, formatTime, tzLabel } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { ConfirmDialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { cx } from '../components/cx';
import { ReasonDialog, Row, useMountTime } from '../engagement/shared';

type Item = { id: string; service_id: string; variant_id: string | null; staff_id: string; service_name_ar: string | null; service_name_en: string | null; staff_name: string; starts_at: string; ends_at: string; duration_min: number; line_total_minor: number; addon_ids: string[] };
type Detail = {
  id: string; number: string; status: string; payment_status: string; starts_at: string; ends_at: string; timezone: string; branch_id: string;
  subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number; deposit_due_minor: number; paid_minor: number; refunded_minor: number; currency: string;
  hold_expires_at: string | null; customer_note: string | null; cancelled_at: string | null; cancel_source: string | null;
  tenant: { name: string; slug: string }; items: Item[];
  terms: { free_cancellation_hours: number | null; late_cancellation_fee_bp: number | null; policy_text_ar: string | null; policy_text_en: string | null; tax_label: string | null; captured_at: string | null };
  payments: Array<{ id: string; kind: string; method: string; amount_minor: number; status: string; captured_at: string | null; created_at: string }>;
  receipts: Array<{ id: string; number: string; kind: string; total_minor: number; issued_at: string }>;
  group_session: { id: string; seats: number } | null;
  actions: { can_cancel: boolean; can_reschedule: boolean; cancellation_preview: { refund_minor: number; fee_minor: number; basis: string } | null; checkout_path: string | null };
};

const tone = (s: string) => (s === 'confirmed' || s === 'completed' ? 'ok' : s === 'cancelled' || s === 'expired' || s === 'no_show' ? 'neutral' : 'warn');

export function BookingDetail({ id }: { id: string }) {
  const { t, locale, pick, timeFormat } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useApiQuery<Detail>(['account-booking', id], `/api/v1/account/bookings/${id}`);
  const [cancelling, setCancelling] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const mountedAt = useMountTime();
  const Back = locale === 'ar' ? ArrowRight : ArrowLeft;
  const back = <Link href="/account/bookings" className="mb-3 inline-flex items-center gap-1 text-sm text-luma-700 hover:underline"><Back className="size-4" aria-hidden />{t('fe.account.back')}</Link>;
  if (q.isLoading) return <div>{back}<LoadingState rows={4} /></div>;
  if (q.error || !q.data) return <div>{back}<ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  const b = q.data;
  const money = (v: number) => formatMoney(v, b.currency, locale);
  const at = (v: string, o: { time?: boolean; date?: boolean; weekday?: boolean } = {}) => formatDateTime(v, { tz: b.timezone, locale, timeFormat, ...o });
  const policyText = pick(b.terms.policy_text_ar, b.terms.policy_text_en);
  const due = Math.max(0, b.total_minor - b.paid_minor);
  const refresh = () => { q.refetch(); qc.invalidateQueries({ queryKey: ['account-bookings'] }); };

  return (
    <div className="flex flex-col gap-4">
      {back}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href={`/s/${b.tenant.slug}`} className="inline-flex items-center gap-1 font-semibold text-luma-900 hover:underline"><Store className="size-4" aria-hidden />{b.tenant.name}</Link>
            <p className="mt-1 flex items-center gap-1.5 text-lg font-medium"><CalendarClock className="size-5 text-luma-700" aria-hidden />{at(b.starts_at, { weekday: true })}</p>
            <p className="text-xs text-ink-muted">{t('time.tz_note', { tz: tzLabel(b.timezone, locale) })} · {t('account.bookings.number')}: <span dir="ltr" className="font-mono">{b.number}</span></p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge tone={tone(b.status)}>{t(`account.booking_status.${b.status}`)}</Badge>
            <Badge tone={b.payment_status === 'paid' ? 'ok' : b.payment_status.includes('refund') ? 'info' : 'neutral'}>{t(`booking.payment_status.${b.payment_status}`)}</Badge>
          </div>
        </div>

        {b.actions.checkout_path ? (
          <Alert tone="warn" className="mt-4" title={t('fe.account.hold_pending')}>
            <p>{b.hold_expires_at ? t('fe.account.hold_until', { time: at(b.hold_expires_at, { date: false }) }) : null}</p>
            <a href={b.actions.checkout_path} className="mt-2 inline-flex items-center gap-1 font-semibold text-luma-800 underline"><CreditCard className="size-4" aria-hidden />{t('fe.account.complete_payment')}</a>
          </Alert>
        ) : null}

        <ul className="mt-4 flex flex-col divide-y divide-line">
          {b.items.map((i) => (
            <li key={i.id} className="flex items-start justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{pick(i.service_name_ar, i.service_name_en)}</p>
                <p className="text-xs text-ink-muted">{formatTime(i.starts_at, { tz: b.timezone, locale, timeFormat })}–{formatTime(i.ends_at, { tz: b.timezone, locale, timeFormat })} · <bdi>{t('account.bookings.with', { name: i.staff_name })}</bdi></p>
              </div>
              <span dir="ltr" className="shrink-0">{money(i.line_total_minor)}</span>
            </li>
          ))}
        </ul>
        {b.group_session ? <p className="text-xs text-ink-muted">{t('fe.account.group_seats', { n: b.group_session.seats })}</p> : null}
        <div className="mt-2 border-t border-line pt-2">
          {b.discount_minor ? <Row label={t('fe.account.discount')}><span dir="ltr">−{money(b.discount_minor)}</span></Row> : null}
          {b.tax_minor ? <Row label={b.terms.tax_label || t('booking.checkout.tax')}><span dir="ltr">{money(b.tax_minor)}</span></Row> : null}
          <Row label={t('booking.flow.total')} className="text-base"><span dir="ltr">{money(b.total_minor)}</span></Row>
          <Row label={t('booking.checkout.paid')}><span dir="ltr">{money(b.paid_minor)}</span></Row>
          {b.refunded_minor ? <Row label={t('fe.account.refunded')}><span dir="ltr">{money(b.refunded_minor)}</span></Row> : null}
          {due > 0 && !['cancelled', 'expired', 'no_show'].includes(b.status) ? <Row label={t('booking.checkout.amount_due')}><span dir="ltr">{money(due)}</span></Row> : null}
        </div>
        {b.customer_note ? <p className="mt-2 rounded-lg bg-luma-50 p-2 text-sm"><span className="text-xs text-ink-muted">{t('fe.account.your_note')}: </span>{b.customer_note}</p> : null}

        {b.actions.can_cancel || b.actions.can_reschedule ? (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            {b.actions.can_reschedule ? <Button variant="outline" onClick={() => setRescheduling((v) => !v)} aria-expanded={rescheduling}>{t('booking.actions.reschedule')}</Button> : null}
            {b.actions.can_cancel ? <Button variant="ghost" className="text-danger" onClick={() => setCancelling(true)}>{t('fe.account.cancel_booking')}</Button> : null}
          </div>
        ) : b.status !== 'cancelled' && b.status !== 'completed' && Date.parse(b.starts_at) <= mountedAt ? (
          <p className="mt-4 text-xs text-ink-muted">{t('fe.account.started_contact')}</p>
        ) : null}
      </Card>

      {rescheduling && b.actions.can_reschedule ? <ReschedulePanel b={b} onDone={() => { setRescheduling(false); refresh(); }} /> : null}

      <Card title={t('booking.checkout.policy')}>
        <ul className="list-disc ps-5 text-sm">
          {b.terms.free_cancellation_hours != null ? <li>{t('booking.checkout.policy_free', { h: b.terms.free_cancellation_hours })}</li> : null}
          {b.terms.late_cancellation_fee_bp ? <li>{t('booking.checkout.policy_fee', { p: b.terms.late_cancellation_fee_bp / 100 })}</li> : null}
        </ul>
        {policyText ? <p className="mt-2 whitespace-pre-line text-sm text-ink-muted">{policyText}</p> : null}
        <p className="mt-2 text-xs text-ink-muted">{t('fe.account.terms_snapshot')}{b.terms.captured_at ? ` (${at(b.terms.captured_at)})` : ''}</p>
      </Card>

      {b.payments.length || b.receipts.length ? (
        <Card title={t('fe.account.payments')}>
          {b.payments.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm">
              {b.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                  <span>{t(`fe.methods.${p.method}`)} · <span className="text-xs text-ink-muted">{at(p.captured_at ?? p.created_at)}</span></span>
                  <span className="flex items-center gap-2"><Badge tone={p.status === 'captured' ? 'ok' : p.status === 'failed' ? 'danger' : 'neutral'}>{t(`fe.payment_status.${p.status}`)}</Badge><span dir="ltr">{money(p.amount_minor)}</span></span>
                </li>
              ))}
            </ul>
          ) : null}
          {b.receipts.length ? (
            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-ink-muted">{t('fe.account.receipts')}</p>
              <ul className="flex flex-col gap-1">
                {b.receipts.map((r) => (
                  <li key={r.id}>
                    <a href={`/api/v1/account/bookings/${b.id}/receipts/${r.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-luma-700 hover:underline">
                      <FileText className="size-4" aria-hidden />{t(`fe.documents.kinds.${r.kind}`)} <span dir="ltr" className="font-mono">{r.number}</span> · <span dir="ltr">{money(r.total_minor)}</span><ExternalLink className="size-3" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : <p className="mt-2 text-xs text-ink-muted">{t('fe.account.no_receipts')}</p>}
        </Card>
      ) : null}

      <ReasonDialog open={cancelling} onClose={() => setCancelling(false)} title={t('fe.account.cancel_title')} confirmLabel={t('fe.account.cancel_booking')} maxLength={500}
        body={<CancelTerms b={b} money={money} />}
        onConfirm={async (reason) => {
          const r = await api<{ refund_due_minor: number }>(`/api/v1/account/bookings/${b.id}/cancel`, { body: { reason } });
          setCancelling(false); refresh();
          toast({ tone: 'ok', text: r.refund_due_minor ? t('fe.account.cancelled_refund', { amount: money(r.refund_due_minor) }) : t('fe.account.cancelled') });
        }} />
    </div>
  );
}

function CancelTerms({ b, money }: { b: Detail; money: (v: number) => string }) {
  const { t } = useI18n();
  const p = b.actions.cancellation_preview;
  return (
    <div className="flex flex-col gap-2 text-sm text-ink">
      <ul className="list-disc ps-5 text-ink-muted">
        {b.terms.free_cancellation_hours != null ? <li>{t('booking.checkout.policy_free', { h: b.terms.free_cancellation_hours })}</li> : null}
        {b.terms.late_cancellation_fee_bp ? <li>{t('booking.checkout.policy_fee', { p: b.terms.late_cancellation_fee_bp / 100 })}</li> : null}
      </ul>
      {p ? (
        <div className="rounded-lg border border-line bg-luma-50 p-3">
          <p className="font-medium">{t(`fe.account.basis.${p.basis}`)}</p>
          {p.basis !== 'nothing_paid' ? (
            <>
              <Row label={t('fe.account.refund_preview')}><span dir="ltr">{money(p.refund_minor)}</span></Row>
              {p.fee_minor ? <Row label={t('fe.account.fee_retained')}><span dir="ltr">{money(p.fee_minor)}</span></Row> : null}
            </>
          ) : null}
          <p className="mt-1 text-xs text-ink-muted">{t('fe.account.preview_note')}</p>
        </div>
      ) : null}
    </div>
  );
}

type Option = { start: string; end: string; items: Array<{ key: string; service_id: string; staff_id: string; staff_name: string; start: string; end: string; price_minor: number }> };
type Search = { timezone: string; days: Record<string, Option[]>; next_available_date: string | null };

function ReschedulePanel({ b, onDone }: { b: Detail; onDone: () => void }) {
  const { t, locale, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const tz = b.timezone;
  const today = DateTime.now().setZone(tz).startOf('day');
  const [windowStart, setWindowStart] = useState(today);
  const [sameStaff, setSameStaff] = useState(true);
  const [day, setDay] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Option | null>(null);
  const [priceChange, setPriceChange] = useState<{ old_total_minor: number; new_total_minor: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const from = windowStart.toISODate()!;
  const to = windowStart.plus({ days: 6 }).toISODate()!;
  const items = useMemo(() => b.items.map((i) => ({ key: i.id, service_id: i.service_id, variant_id: i.variant_id, addon_ids: i.addon_ids, staff_id: sameStaff ? i.staff_id : null })), [b.items, sameStaff]);
  // Availability is a read-only POST search on the storefront API (live, never cached across visits).
  const search = useQuery<Search, ApiError>({
    queryKey: ['resched-avail', b.id, from, sameStaff],
    queryFn: ({ signal }) => api<Search>(`/api/v1/s/${b.tenant.slug}/availability`, { body: { branch_id: b.branch_id, items, from, to }, signal }),
    staleTime: 0, gcTime: 0, retry: false,
  });
  const data = { res: search.data ?? null, err: search.error };
  const loading = search.isLoading;
  const days = Array.from({ length: 7 }, (_, i) => windowStart.plus({ days: i }));
  const options = (day && data.res?.days[day]) || [];
  const newTotal = chosen ? chosen.items.reduce((a, i) => a + i.price_minor, 0) : null;

  const save = useApiMutation<number | undefined, unknown>((accept) => api(`/api/v1/account/bookings/${b.id}/reschedule`, {
    body: { items: chosen!.items.map((i) => { const src = b.items.find((x) => x.id === i.key)!; return { key: i.key, service_id: i.service_id, variant_id: src.variant_id, addon_ids: src.addon_ids, staff_id: i.staff_id, start: i.start }; }), ...(accept != null ? { accept_total_minor: accept } : {}) },
  }), {
    onSuccess: () => { setConfirm(false); setPriceChange(null); toast({ tone: 'ok', text: t('fe.account.rescheduled') }); onDone(); },
  });
  function submit(accept?: number) {
    save.mutate(accept, {
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'price_changed') { setPriceChange(e.details as { old_total_minor: number; new_total_minor: number }); setConfirm(false); }
        if (e instanceof ApiError && e.code === 'slot_unavailable') { setChosen(null); setConfirm(false); search.refetch(); }
      },
    });
  }
  const fmt = (iso: string) => formatTime(iso, { tz, locale, timeFormat });

  return (
    <Card title={t('booking.dashboard.reschedule_title')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">{t('fe.account.reschedule_intro')}</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-luma-700" checked={sameStaff} onChange={(e) => { setSameStaff(e.target.checked); setChosen(null); }} />{t('fe.account.same_staff')}</label>
        <div className="flex items-center gap-1 overflow-x-auto pb-1" role="tablist" aria-label={t('fields.date')}>
          <Button size="sm" variant="outline" disabled={windowStart <= today} onClick={() => { setWindowStart(windowStart.minus({ days: 7 }) < today ? today : windowStart.minus({ days: 7 })); setDay(null); setChosen(null); }} aria-label={t('actions.previous')}>‹</Button>
          {days.map((d) => {
            const iso = d.toISODate()!;
            const n = data.res?.days[iso]?.length ?? 0;
            return (
              <button key={iso} role="tab" aria-selected={day === iso} disabled={!n} onClick={() => { setDay(iso); setChosen(null); }}
                className={cx('flex min-w-12 flex-col items-center rounded-lg border px-2 py-1.5 text-xs disabled:opacity-40', day === iso ? 'border-luma-700 bg-luma-700 text-white' : 'border-line bg-white')}>
                <span>{d.setLocale(locale).toFormat('ccc')}</span><span className="text-base font-semibold">{d.toFormat('d')}</span>
              </button>
            );
          })}
          <Button size="sm" variant="outline" onClick={() => { setWindowStart(windowStart.plus({ days: 7 })); setDay(null); setChosen(null); }} aria-label={t('actions.next')}>›</Button>
        </div>
        {loading ? <LoadingState rows={2} label={t('booking.flow.loading_times')} /> : data.err ? <ErrorState error={data.err} /> : !day ? (
          <p className="text-sm text-ink-muted">{Object.values(data.res?.days ?? {}).some((x) => x.length) ? t('fe.account.pick_day') : t('booking.flow.no_times')}</p>
        ) : options.length ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {options.map((o) => (
              <button key={o.start} onClick={() => setChosen(o)} aria-pressed={chosen?.start === o.start}
                className={cx('rounded-lg border px-2 py-2 text-sm', chosen?.start === o.start ? 'border-luma-700 bg-luma-700 text-white' : 'border-line bg-white hover:border-luma-500')}>{fmt(o.start)}</button>
            ))}
          </div>
        ) : <p className="text-sm text-ink-muted">{t('booking.flow.no_times')}</p>}
        {!loading && !Object.values(data.res?.days ?? {}).some((x) => x.length) && data.res?.next_available_date ? (
          <button className="self-start text-sm text-luma-700 underline" onClick={() => { setWindowStart(DateTime.fromISO(data.res!.next_available_date!, { zone: tz })); setDay(null); }}>
            {t('booking.flow.next_available', { date: DateTime.fromISO(data.res.next_available_date, { zone: tz }).setLocale(locale).toFormat('cccc d LLLL') })}
          </button>
        ) : null}
        {chosen ? (
          <div className="rounded-lg border border-luma-300 bg-luma-50 p-3 text-sm">
            <p className="font-medium">{formatDateTime(chosen.start, { tz, locale, timeFormat, weekday: true })}</p>
            <p className="text-xs text-ink-muted">{chosen.items.map((i) => t('account.bookings.with', { name: i.staff_name })).join(' · ')}</p>
            {newTotal != null && newTotal !== b.subtotal_minor ? <p className="mt-1 text-xs text-warn">{t('fe.account.price_may_change')}</p> : null}
            <div className="mt-2 flex justify-end"><Button loading={save.isPending} onClick={() => setConfirm(true)}>{t('fe.account.confirm_new_time')}</Button></div>
          </div>
        ) : null}
        {save.error && !(save.error instanceof ApiError && save.error.code === 'price_changed') ? <Alert tone="danger">{msg(save.error)}</Alert> : null}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} loading={save.isPending} title={t('fe.account.reschedule_confirm_title')}
        body={chosen ? t('fe.account.reschedule_confirm_body', { from: formatDateTime(b.starts_at, { tz, locale, timeFormat }), to: formatDateTime(chosen.start, { tz, locale, timeFormat }) }) : null}
        onConfirm={() => submit()} />
      <ConfirmDialog open={!!priceChange} onClose={() => setPriceChange(null)} loading={save.isPending} title={t('fe.account.price_changed_title')}
        body={priceChange ? t('booking.dashboard.price_changed', { new: formatMoney(priceChange.new_total_minor, b.currency, locale), old: formatMoney(priceChange.old_total_minor, b.currency, locale) }) : null}
        onConfirm={() => priceChange && submit(priceChange.new_total_minor)} />
    </Card>
  );
}
