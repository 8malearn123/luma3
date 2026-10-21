'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, Hourglass, Store } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, newIdempotencyKey } from '../api';
import { useErrorMessage } from '../hooks';
import { formatMoney } from '@/shared/format';

type Order = {
  id: string; number: string; status: string; fulfillment_method: string; subtotal_minor: number; discount_minor: number; tax_minor: number;
  total_minor: number; paid_minor: number; currency: string; expires_at: string | null;
  items: Array<{ id: string; name_ar: string | null; name_en: string | null; variant_name_ar: string | null; variant_name_en: string | null; unit_price_minor: number; quantity: number; line_total_minor: number }>;
};

const sfBtn = 'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sf)] px-4 py-2.5 text-sm font-medium transition disabled:opacity-50';

/** Pays a pending order. Paid state is only ever shown from the server's order status, never from the redirect. */
export function OrderCheckout({ slug, orderId, returningPaymentId }: { slug: string; orderId: string; returningPaymentId: string | null }) {
  const { t, locale, pick } = useI18n();
  const msg = useErrorMessage();
  const [o, setO] = useState<Order | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [polling, setPolling] = useState(!!returningPaymentId);
  const [key] = useState(newIdempotencyKey);

  const load = useCallback(async () => {
    try { setO(await api<Order>(`/api/v1/s/${slug}/orders/${orderId}`)); } catch (e) { setError(e); }
  }, [slug, orderId]);
  // Fetching on mount: state is set asynchronously after the request resolves.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  useEffect(() => {
    if (!returningPaymentId) return;
    let stop = false;
    const tick = async (n: number) => {
      try {
        const s = await api<{ status: string }>(`/api/v1/s/${slug}/payments/${returningPaymentId}`);
        if (s.status === 'captured' || s.status === 'failed' || s.status === 'cancelled' || n > 20) { setPolling(false); await load(); return; }
      } catch { /* keep polling briefly */ }
      if (!stop) setTimeout(() => tick(n + 1), 1500);
    };
    tick(0);
    return () => { stop = true; };
  }, [returningPaymentId, slug, load]);

  if (error && !o) return <Centered><p role="alert">{msg(error)}</p></Centered>;
  if (!o) return <Centered><p role="status">{t('states.loading')}</p></Centered>;

  const left = o.expires_at ? Math.max(0, Date.parse(o.expires_at) - now) : 0;
  const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
  const paid = ['paid', 'preparing', 'ready', 'collected'].includes(o.status);
  const expired = o.status === 'pending_payment' && o.expires_at !== null && left === 0;

  async function pay() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ payment: { checkout_url: string; id: string } }>(`/api/v1/s/${slug}/orders/${orderId}/checkout`, { body: {}, idempotencyKey: key });
      const url = new URL(r.payment.checkout_url, window.location.origin);
      url.searchParams.set('return', `/s/${slug}/checkout/order/${orderId}?payment=${r.payment.id}`);
      window.location.assign(url.toString());
    } catch (e) { setError(e); setBusy(false); }
  }

  return (
    <div className="storefront mx-auto max-w-2xl px-4 py-6 text-sf-text">
      <h1 className="font-sf-heading text-2xl">{paid ? t('order_checkout.paid_title') : t('order_checkout.title')}</h1>
      <p className="text-sm text-sf-muted" dir="ltr">{o.number}</p>
      {error ? <div role="alert" className="my-3 rounded-[var(--radius-sf)] border border-red-200 bg-red-50 p-3 text-sm text-red-800">{msg(error)}</div> : null}
      {polling ? <p role="status" className="my-3 inline-flex items-center gap-2 text-sm"><Hourglass className="size-4 animate-pulse" />{t('booking.checkout.processing')}</p> : null}

      <section className="my-4 rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-4">
        <ul className="flex flex-col gap-2 text-sm">
          {o.items.map((i) => (
            <li key={i.id} className="flex justify-between gap-2">
              <span>
                <span className="font-medium">{pick(i.name_ar, i.name_en)}</span>
                {pick(i.variant_name_ar, i.variant_name_en) ? <span className="text-sf-muted"> · {pick(i.variant_name_ar, i.variant_name_en)}</span> : null}
                <span className="text-sf-muted"> · {t('order_checkout.qty')} {i.quantity}</span>
              </span>
              <span>{formatMoney(i.line_total_minor, o.currency, locale)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-sf-muted"><Store className="size-3.5" />{t('order_checkout.pickup')}</p>
        <dl className="mt-3 grid grid-cols-2 gap-1 border-t border-sf-border pt-3 text-sm">
          <dt>{t('order_checkout.subtotal')}</dt><dd className="text-end">{formatMoney(o.subtotal_minor, o.currency, locale)}</dd>
          {o.discount_minor ? <><dt>{t('finance.discounts')}</dt><dd className="text-end">−{formatMoney(o.discount_minor, o.currency, locale)}</dd></> : null}
          {o.tax_minor ? <><dt>{t('booking.checkout.tax')}</dt><dd className="text-end">{formatMoney(o.tax_minor, o.currency, locale)}</dd></> : null}
          <dt className="font-semibold">{t('booking.flow.total')}</dt><dd className="text-end font-semibold">{formatMoney(o.total_minor, o.currency, locale)}</dd>
          {o.paid_minor ? <><dt>{t('booking.checkout.paid')}</dt><dd className="text-end">{formatMoney(o.paid_minor, o.currency, locale)}</dd></> : null}
        </dl>
      </section>

      {paid ? (
        <div className="flex flex-col gap-3">
          <p className="inline-flex items-center gap-2 text-sf-primary"><CheckCircle2 className="size-5" />{t(`commerce.orders.status.${o.status}`)}</p>
          <p className="text-sm text-sf-muted">{t('order_checkout.next_steps')}</p>
          <Link className={`${sfBtn} self-start border border-sf-border`} href={`/s/${slug}`}>{t('booking.checkout.back_to_store')}</Link>
        </div>
      ) : o.status === 'cancelled' || expired ? (
        <div className="rounded-[var(--radius-sf)] border border-sf-border p-4">
          <p>{expired ? t('order_checkout.expired') : t('order_checkout.cancelled')}</p>
          <Link className="underline" href={`/s/${slug}/cart`}>{t('order_checkout.back_to_cart')}</Link>
        </div>
      ) : (
        <section className="flex flex-col gap-3">
          {o.expires_at ? <p className="inline-flex items-center gap-2 text-sm text-sf-muted"><Clock className="size-4" />{t('order_checkout.reserved_for', { time: `${mm}:${String(ss).padStart(2, '0')}` })}</p> : null}
          <button className={`${sfBtn} bg-sf-primary text-sf-on-primary`} disabled={busy || polling} onClick={pay}>{t('order_checkout.pay_now')} · {formatMoney(o.total_minor - o.paid_minor, o.currency, locale)}</button>
          <p className="text-center text-[11px] text-sf-muted">{t('booking.checkout.sandbox_badge')}</p>
        </section>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[50vh] items-center justify-center p-6 text-center text-sf-text">{children}</div>;
}
