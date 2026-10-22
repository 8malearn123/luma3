'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ImageIcon, Loader2, Minus, Plus, ShoppingBag, Store, Tag, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatMoney } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { cx } from '../components/cx';

type Line = {
  variant_id: string; product_id: string; name_ar: string | null; name_en: string | null; variant_name_ar: string | null; variant_name_en: string | null;
  image_asset_id: string | null; quantity: number; unit_price_minor: number; added_unit_price_minor: number; price_changed: boolean; line_total_minor: number;
  available: number; max_per_order: number; problems: Array<'unavailable' | 'out_of_stock' | 'insufficient_stock' | 'exceeds_max_per_order'>;
};
type Cart = {
  id: string | null; items: Line[]; item_count: number; subtotal_minor: number; currency: string; has_price_changes: boolean; has_problems: boolean;
  signed_in: boolean; verified: boolean; fulfillment_methods: Array<{ method: string; enabled: boolean }>;
};

const btn = 'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sf)] px-4 py-2.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed';
const primary = `${btn} bg-sf-primary text-sf-on-primary hover:opacity-90`;
const outline = `${btn} border border-sf-border text-sf-text hover:bg-sf-bg`;
const input = 'w-full rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface px-3 py-2 text-sm text-sf-text focus:outline-none focus:ring-2 focus:ring-sf-primary/30';

/** Storefront cart (/s/{slug}/cart, optionally ?add={variantId}&qty={n}). Styled with the business's sf-* theme tokens. */
export function CartView({ slug }: { slug: string }) {
  const { t, pick, locale } = useI18n();
  const msg = useErrorMessage();
  const router = useRouter();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const key = ['sf-cart', slug];
  const cart = useApiQuery<Cart>(key, `/api/v1/s/${slug}/cart`);
  const money = (m: number) => formatMoney(m, cart.data?.currency ?? 'SAR', locale);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [coupon, setCoupon] = useState('');
  const [applied, setApplied] = useState<{ code: string; discount_minor: number } | null>(null);
  const [couponErr, setCouponErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const addedRef = useRef(false);

  // ?add=&qty= → add once, then show the clean cart URL.
  useEffect(() => {
    const add = sp.get('add');
    if (!add || addedRef.current) return;
    addedRef.current = true;
    const qty = Math.min(999, Math.max(1, Number.parseInt(sp.get('qty') ?? '1', 10) || 1));
    api<Cart>(`/api/v1/s/${slug}/cart/items`, { body: { variant_id: add, quantity: qty } })
      .then((c) => { qc.setQueryData(key, (old: Cart | undefined) => ({ ...(old ?? {}), ...c } as Cart)); qc.invalidateQueries({ queryKey: key }); setNotice({ tone: 'ok', text: t('commerce.cart.added') }); })
      .catch((e) => setNotice({ tone: 'err', text: msg(e) }))
      .finally(() => router.replace(`/s/${slug}/cart`, { scroll: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, slug]);

  async function mutateLine(variantId: string, fn: () => Promise<Cart>) {
    setBusyLine(variantId); setNotice(null);
    try { const c = await fn(); qc.setQueryData(key, (old: Cart | undefined) => ({ ...(old ?? {}), ...c } as Cart)); setApplied(null); }
    catch (e) { setNotice({ tone: 'err', text: msg(e) }); }
    finally { setBusyLine(null); }
  }
  const setQty = (l: Line, q: number) => mutateLine(l.variant_id, () => api<Cart>(`/api/v1/s/${slug}/cart/items/${l.variant_id}`, { method: 'PATCH', body: { quantity: q } }));
  const remove = (l: Line) => mutateLine(l.variant_id, () => api<Cart>(`/api/v1/s/${slug}/cart/items/${l.variant_id}`, { method: 'DELETE' }));
  const accept = () => mutateLine('ack', () => api<Cart>(`/api/v1/s/${slug}/cart/acknowledge`, { body: {} }));

  async function applyCoupon() {
    setCouponErr(null);
    try { const r = await api<{ code: string; discount_minor: number }>(`/api/v1/s/${slug}/coupons/validate`, { body: { code: coupon.trim() } }); setApplied(r); }
    catch (e) { setApplied(null); setCouponErr(msg(e)); }
  }

  const checkout = useApiMutation<void, { id: string; checkout_path: string }>(
    (_v, { idempotencyKey }) => api(`/api/v1/s/${slug}/orders`, { body: { fulfillment_method: 'pickup', ...(applied ? { coupon_code: applied.code } : {}), ...(note.trim() ? { note: note.trim() } : {}) }, idempotencyKey }),
    { onSuccess: (r) => { qc.invalidateQueries({ queryKey: key }); router.push(r.checkout_path); } },
  );
  useEffect(() => {
    const e = checkout.error;
    if (e instanceof ApiError && ['prices_changed', 'out_of_stock', 'product_unavailable', 'max_per_order_exceeded'].includes(e.code)) cart.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout.error]);

  const c = cart.data;
  const loginHref = `/auth/login?next=${encodeURIComponent(`/s/${slug}/cart`)}`;
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 font-sf-body text-sf-text">
      <h1 className="mb-6 font-sf-heading text-2xl font-semibold">{t('commerce.cart.title')}</h1>
      {notice ? <p role={notice.tone === 'err' ? 'alert' : 'status'} className={cx('mb-4 rounded-[var(--radius-sf)] border p-3 text-sm', notice.tone === 'err' ? 'border-danger/30 bg-danger-bg text-danger' : 'border-sf-border bg-sf-surface')}>{notice.text}</p> : null}

      {cart.isLoading ? (
        <div role="status" className="flex flex-col gap-3"><span className="sr-only">{t('states.loading')}</span>{[0, 1].map((i) => <div key={i} className="h-24 animate-pulse rounded-[var(--radius-sf)] bg-sf-surface" />)}</div>
      ) : cart.error ? (
        <div role="alert" className="rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-6 text-center">
          <p className="mb-3">{msg(cart.error)}</p>
          <button className={outline} onClick={() => cart.refetch()}>{t('actions.retry')}</button>
        </div>
      ) : !c || !c.items.length ? (
        <div className="flex flex-col items-center gap-3 rounded-[var(--radius-sf)] border border-dashed border-sf-border bg-sf-surface p-10 text-center">
          <ShoppingBag className="size-10 text-sf-muted" aria-hidden />
          <p className="font-medium">{t('commerce.cart.empty')}</p>
          <p className="text-sm text-sf-muted">{t('commerce.cart.empty_hint')}</p>
          <Link href={`/s/${slug}`} className={primary}><Store className="size-4" aria-hidden />{t('commerce.cart.browse')}</Link>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <section aria-label={t('commerce.cart.title')} className="flex flex-col gap-3">
            {c.has_price_changes ? (
              <div role="alert" className="flex flex-col gap-2 rounded-[var(--radius-sf)] border border-warn/30 bg-warn-bg p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden /><div><p className="font-medium">{t('commerce.cart.prices_changed_title')}</p><p className="text-sf-muted">{t('commerce.cart.prices_changed_body')}</p></div></div>
                <button className={primary} disabled={busyLine === 'ack'} onClick={accept}>{busyLine === 'ack' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}{t('commerce.cart.accept_prices')}</button>
              </div>
            ) : null}
            <ul className="flex flex-col divide-y divide-sf-border rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface">
              {c.items.map((l) => {
                const name = pick(l.name_ar, l.name_en);
                const vname = pick(l.variant_name_ar, l.variant_name_en);
                const busy = busyLine === l.variant_id;
                const maxQ = Math.max(1, Math.min(l.max_per_order, l.available || 1));
                return (
                  <li key={l.variant_id} className={cx('flex gap-3 p-3 sm:p-4', l.problems.length ? 'bg-danger-bg/30' : '')}>
                    {l.image_asset_id
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={`/api/v1/media/${l.image_asset_id}`} alt="" className="size-20 shrink-0 rounded-[var(--radius-sf)] border border-sf-border object-cover" />
                      : <span className="flex size-20 shrink-0 items-center justify-center rounded-[var(--radius-sf)] bg-sf-bg"><ImageIcon className="size-6 text-sf-muted" aria-hidden /></span>}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{name}</p>
                          {vname ? <p className="text-xs text-sf-muted">{vname}</p> : null}
                        </div>
                        <p className="shrink-0 font-semibold" dir="ltr">{money(l.line_total_minor)}</p>
                      </div>
                      <p className="text-xs text-sf-muted"><span dir="ltr">{money(l.unit_price_minor)}</span> {t('commerce.cart.each')}</p>
                      {l.price_changed ? <p className="text-xs font-medium text-warn">{t('commerce.cart.price_changed', { from: money(l.added_unit_price_minor), to: money(l.unit_price_minor) })}</p> : null}
                      {l.problems.map((p) => <p key={p} className="text-xs font-medium text-danger">{t(`commerce.cart.problem.${p}`, { n: p === 'insufficient_stock' ? l.available : l.max_per_order })}</p>)}
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <div className="inline-flex items-center rounded-[var(--radius-sf)] border border-sf-border" role="group" aria-label={`${t('commerce.cart.quantity')}: ${name}`}>
                          <button className="p-2 disabled:opacity-40" aria-label="−" disabled={busy || l.quantity <= 1} onClick={() => setQty(l, l.quantity - 1)}><Minus className="size-4" /></button>
                          <span className="min-w-8 text-center text-sm" aria-live="polite">{busy ? <Loader2 className="mx-auto size-4 animate-spin" aria-hidden /> : l.quantity}</span>
                          <button className="p-2 disabled:opacity-40" aria-label="+" disabled={busy || l.quantity >= maxQ || l.problems.includes('unavailable')} onClick={() => setQty(l, l.quantity + 1)}><Plus className="size-4" /></button>
                        </div>
                        <button className="inline-flex items-center gap-1 text-xs text-sf-muted hover:text-danger" disabled={busy} onClick={() => remove(l)}><Trash2 className="size-4" aria-hidden />{t('commerce.cart.remove')}</button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <aside className="flex h-fit flex-col gap-4 rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t('commerce.cart.fulfillment')}</legend>
              <label className="flex items-start gap-2 text-sm"><input type="radio" name="fulfillment" checked readOnly className="mt-1 accent-sf-primary" /><span>{t('commerce.cart.pickup')}<span className="block text-xs text-sf-muted">{t('commerce.cart.pickup_hint')}</span></span></label>
              <p className="text-xs text-sf-muted">{t('commerce.cart.delivery_unavailable')}</p>
            </fieldset>
            {c.signed_in ? (
              <div className="flex flex-col gap-1">
                <label htmlFor="sf-coupon" className="text-sm font-medium">{t('commerce.cart.coupon')}</label>
                {applied ? (
                  <div className="flex items-center justify-between text-sm"><span className="inline-flex items-center gap-1"><Tag className="size-4" aria-hidden /><span dir="ltr" className="font-mono">{applied.code}</span> · {t('commerce.cart.coupon_applied', { amount: money(applied.discount_minor) })}</span>
                    <button className="text-xs underline" onClick={() => { setApplied(null); setCoupon(''); }}>{t('commerce.cart.remove_coupon')}</button></div>
                ) : (
                  <div className="flex gap-2">
                    <input id="sf-coupon" dir="ltr" className={input} value={coupon} maxLength={40} onChange={(e) => setCoupon(e.target.value)} aria-invalid={!!couponErr || undefined} aria-describedby={couponErr ? 'sf-coupon-err' : undefined} />
                    <button className={outline} disabled={coupon.trim().length < 3} onClick={applyCoupon}>{t('commerce.cart.apply')}</button>
                  </div>
                )}
                {couponErr ? <p id="sf-coupon-err" className="text-xs text-danger">{couponErr}</p> : null}
              </div>
            ) : null}
            {c.signed_in ? (
              <div className="flex flex-col gap-1">
                <label htmlFor="sf-note" className="text-sm font-medium">{t('commerce.cart.note')}</label>
                <textarea id="sf-note" rows={2} maxLength={500} className={input} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            ) : null}
            <dl className="flex flex-col gap-1 border-t border-sf-border pt-3 text-sm">
              <div className="flex justify-between"><dt>{t('commerce.cart.subtotal')}</dt><dd dir="ltr">{money(c.subtotal_minor)}</dd></div>
              {applied ? <div className="flex justify-between text-ok"><dt>{t('commerce.orders.discount')}</dt><dd dir="ltr">−{money(applied.discount_minor)}</dd></div> : null}
              <div className="flex justify-between text-base font-semibold"><dt>{t('commerce.cart.total')}</dt><dd dir="ltr">{money(c.subtotal_minor - (applied?.discount_minor ?? 0))}</dd></div>
            </dl>
            <p className="text-xs text-sf-muted">{t('commerce.cart.tax_note')}</p>
            {checkout.error ? <p role="alert" className="rounded-[var(--radius-sf)] bg-danger-bg p-2 text-sm text-danger">{msg(checkout.error)}</p> : null}
            {c.has_problems ? <p className="text-sm text-danger">{t('commerce.cart.fix_problems')}</p> : null}
            {!c.signed_in ? (
              <>
                <Link href={loginHref} className={primary}>{t('commerce.cart.sign_in_to_checkout')}</Link>
                <p className="text-xs text-sf-muted">{t('commerce.cart.sign_in_note')}</p>
              </>
            ) : !c.verified ? (
              <p className="text-sm text-warn">{t('commerce.cart.verify_note')}</p>
            ) : (
              <button className={primary} disabled={checkout.isPending || c.has_problems || c.has_price_changes} onClick={() => checkout.mutate()}>
                {checkout.isPending ? <><Loader2 className="size-4 animate-spin" aria-hidden />{t('commerce.cart.creating')}</> : t('commerce.cart.checkout')}
              </button>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
