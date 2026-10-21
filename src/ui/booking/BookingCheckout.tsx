'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, Hourglass } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError, newIdempotencyKey } from '../api';
import { useErrorMessage } from '../hooks';
import { formatDateTime, formatMoney, formatTime } from '@/shared/format';
import type { PaymentTerms } from '@/shared/payments';

type Booking = {
  id: string; number: string; status: string; payment_status: string; starts_at: string; ends_at: string; timezone: string;
  subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number; deposit_due_minor: number; paid_minor: number; currency: string;
  payment_terms: PaymentTerms; hold_expires_at: string | null; policy_snapshot: { free_cancellation_hours?: number; late_cancellation_fee_bp?: number };
  items: Array<{ id: string; service_name_ar: string | null; service_name_en: string | null; staff_name: string; starts_at: string; ends_at: string; line_total_minor: number }>;
};

const sfBtn = 'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sf)] px-4 py-2.5 text-sm font-medium transition disabled:opacity-50';

export function BookingCheckout({ slug, bookingId, timezone, returningPaymentId, giftCards, memberships }: { slug: string; bookingId: string; timezone: string; returningPaymentId: string | null; giftCards: boolean; memberships: boolean }) {
  const { t, locale, pick, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const [b, setB] = useState<Booking | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [option, setOption] = useState<'full' | 'deposit' | 'on_site' | null>(null);
  const [now, setNow] = useState(Date.now());
  const [polling, setPolling] = useState(!!returningPaymentId);
  const [gift, setGift] = useState('');
  const [key] = useState(newIdempotencyKey);
  const [giftKey, setGiftKey] = useState(newIdempotencyKey);

  const load = useCallback(async () => {
    try { setB(await api<Booking>(`/api/v1/s/${slug}/bookings/${bookingId}`)); } catch (e) { setError(e); }
  }, [slug, bookingId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  // After returning from the provider, confirm only from the server-side payment status.
  useEffect(() => {
    if (!returningPaymentId) return;
    let stop = false;
    const tick = async (n: number) => {
      try {
        const s = await api<{ status: string; target: { status: string } | null }>(`/api/v1/s/${slug}/payments/${returningPaymentId}`);
        if (s.status === 'captured' || s.status === 'failed' || s.status === 'cancelled' || n > 20) { setPolling(false); await load(); return; }
      } catch { /* keep polling briefly */ }
      if (!stop) setTimeout(() => tick(n + 1), 1500);
    };
    tick(0);
    return () => { stop = true; };
  }, [returningPaymentId, slug, load]);

  if (error && !b) return <Centered><p role="alert">{msg(error)}</p></Centered>;
  if (!b) return <Centered><p role="status">{t('states.loading')}</p></Centered>;

  const expiresIn = b.hold_expires_at ? Math.max(0, Date.parse(b.hold_expires_at) - now) : 0;
  const mm = Math.floor(expiresIn / 60000), ss = Math.floor((expiresIn % 60000) / 1000);
  const terms = b.payment_terms;
  const due = b.total_minor - b.paid_minor;
  const done = ['confirmed', 'pending_approval', 'checked_in', 'completed'].includes(b.status);

  async function pay() {
    if (!option) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ status: string; payment: { checkout_url: string; id: string } | null }>(`/api/v1/s/${slug}/bookings/${bookingId}/checkout`, { body: { option }, idempotencyKey: key });
      if (r.payment) {
        const url = new URL(r.payment.checkout_url, window.location.origin);
        url.searchParams.set('return', `/s/${slug}/checkout/booking/${bookingId}?payment=${r.payment.id}`);
        window.location.href = url.toString();
        return;
      }
      await load();
    } catch (e) { setError(e); if (e instanceof ApiError && e.code === 'terms_changed') await load(); } finally { setBusy(false); }
  }

  async function applyGift() {
    setBusy(true); setError(null);
    try { await api(`/api/v1/s/${slug}/bookings/${bookingId}/gift-card`, { body: { code: gift, amount_minor: due }, idempotencyKey: giftKey }); setGift(''); setGiftKey(newIdempotencyKey()); await load(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function applyMembership() {
    setBusy(true); setError(null);
    try { await api(`/api/v1/s/${slug}/bookings/${bookingId}/apply-membership`, { body: {} }); await load(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <div className="storefront mx-auto max-w-2xl px-4 py-6 text-sf-text">
      <h1 className="font-sf-heading text-2xl">{done ? (b.status === 'pending_approval' ? t('booking.checkout.pending_approval') : t('booking.checkout.confirmed')) : t('booking.checkout.title')}</h1>
      <p className="text-sm text-sf-muted" dir="ltr">{b.number}</p>
      {error ? <div role="alert" className="my-3 rounded-[var(--radius-sf)] border border-red-200 bg-red-50 p-3 text-sm text-red-800">{msg(error)}</div> : null}
      {polling ? <p role="status" className="my-3 inline-flex items-center gap-2 text-sm"><Hourglass className="size-4 animate-pulse" />{t('booking.checkout.processing')}</p> : null}

      <section className="my-4 rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-4">
        <ul className="flex flex-col gap-2 text-sm">
          {b.items.map((i) => (
            <li key={i.id} className="flex justify-between gap-2">
              <span><span className="font-medium">{pick(i.service_name_ar, i.service_name_en)}</span> <span className="text-sf-muted">· {i.staff_name} · {formatTime(i.starts_at, { tz: timezone, locale, timeFormat })}</span></span>
              <span>{formatMoney(i.line_total_minor, b.currency, locale)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-sf-muted">{formatDateTime(b.starts_at, { tz: timezone, locale, timeFormat, weekday: true })}</p>
        <dl className="mt-3 grid grid-cols-2 gap-1 border-t border-sf-border pt-3 text-sm">
          {b.discount_minor ? <><dt>{t('finance.discounts')}</dt><dd className="text-end">−{formatMoney(b.discount_minor, b.currency, locale)}</dd></> : null}
          {b.tax_minor ? <><dt>{t('booking.checkout.tax')}</dt><dd className="text-end">{formatMoney(b.tax_minor, b.currency, locale)}</dd></> : null}
          <dt className="font-semibold">{t('booking.flow.total')}</dt><dd className="text-end font-semibold">{formatMoney(b.total_minor, b.currency, locale)}</dd>
          {b.paid_minor ? <><dt>{t('booking.checkout.paid')}</dt><dd className="text-end">{formatMoney(b.paid_minor, b.currency, locale)}</dd></> : null}
        </dl>
      </section>

      {done ? (
        <div className="flex flex-col gap-3">
          <p className="inline-flex items-center gap-2 text-sf-primary"><CheckCircle2 className="size-5" />{t(`booking.status.${b.status}`)} · {t(`booking.payment_status.${b.payment_status}`)}</p>
          <div className="flex gap-2"><Link className={`${sfBtn} bg-sf-primary text-sf-on-primary`} href={`/account/bookings/${b.id}`}>{t('booking.checkout.view_booking')}</Link><Link className={`${sfBtn} border border-sf-border`} href={`/s/${slug}`}>{t('booking.checkout.back_to_store')}</Link></div>
        </div>
      ) : b.status === 'expired' || (b.status === 'held' && expiresIn === 0) ? (
        <div className="rounded-[var(--radius-sf)] border border-sf-border p-4"><p>{t('booking.checkout.expired')}</p><Link className="underline" href={`/s/${slug}/booking`}>{t('booking.flow.title')}</Link></div>
      ) : (
        <section className="flex flex-col gap-3">
          <p className="inline-flex items-center gap-2 text-sm text-sf-muted"><Clock className="size-4" />{t('booking.checkout.expires_in', { time: `${mm}:${String(ss).padStart(2, '0')}` })}</p>
          {terms.blocked ? (
            <div className="rounded-[var(--radius-sf)] border border-amber-300 bg-amber-50 p-3 text-sm">
              <p>{t('booking.checkout.blocked')}</p>
              {terms.customerExplanation ? <p className="mt-1">{pick(terms.customerExplanation.ar, terms.customerExplanation.en)}</p> : null}
              <p className="mt-1 text-xs">{t('booking.checkout.review_route')} <Link className="underline" href="/account">{t('nav.account')}</Link></p>
            </div>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 font-medium">{t('booking.checkout.how_to_pay')}</legend>
              {terms.customerExplanation ? <p className="text-xs text-sf-muted">{pick(terms.customerExplanation.ar, terms.customerExplanation.en)}</p> : null}
              {(['full', 'deposit', 'on_site'] as const).filter((o) => terms.allowed.includes(o)).map((o) => (
                <label key={o} className="flex items-center gap-2 rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-3 text-sm">
                  <input type="radio" name="pay" value={o} checked={option === o} onChange={() => setOption(o)} />
                  {o === 'deposit' ? t('booking.checkout.deposit', { amount: formatMoney(terms.depositMinor ?? 0, b.currency, locale) }) : t(`booking.checkout.${o}`)}
                </label>
              ))}
              {terms.requiresManualApproval ? <p className="text-xs text-sf-muted">{t('booking.checkout.manual_review')}</p> : null}
              <button className={`${sfBtn} bg-sf-primary text-sf-on-primary`} disabled={!option || busy} onClick={pay}>{t('booking.checkout.confirm')}</button>
              <p className="text-center text-[11px] text-sf-muted">{t('booking.checkout.sandbox_badge')}</p>
            </fieldset>
          )}
          <p className="text-xs text-sf-muted">
            {t('booking.checkout.policy_free', { h: b.policy_snapshot.free_cancellation_hours ?? 24 })}
            {b.policy_snapshot.late_cancellation_fee_bp ? ` ${t('booking.checkout.policy_fee', { p: (b.policy_snapshot.late_cancellation_fee_bp ?? 0) / 100 })}` : ''} <Link className="underline" href={`/s/${slug}/policies`}>{t('booking.checkout.policy')}</Link>
          </p>
          {giftCards && due > 0 ? (
            <div className="flex items-end gap-2">
              <label className="flex-1 text-sm">{t('booking.checkout.gift_card')}<input dir="ltr" value={gift} onChange={(e) => setGift(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX" className="mt-1 h-10 w-full rounded-[var(--radius-sf)] border border-sf-border bg-sf-bg px-2" /></label>
              <button className={`${sfBtn} border border-sf-border`} disabled={busy || gift.length < 8} onClick={applyGift}>{t('booking.checkout.apply')}</button>
            </div>
          ) : null}
          {memberships ? <button className={`${sfBtn} border border-sf-border self-start`} disabled={busy} onClick={applyMembership}>{t('booking.checkout.membership')}</button> : null}
        </section>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[50vh] items-center justify-center p-6 text-center text-sf-text">{children}</div>;
}
