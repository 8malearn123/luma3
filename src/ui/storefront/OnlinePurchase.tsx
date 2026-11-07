'use client';

import { useRef, useState } from 'react';
import { Check, Gift, Sparkles } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney } from '@/shared/format';
import { HEARD_FROM } from '@/shared/acquisition';
import { api, ApiError, newIdempotencyKey } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { cx } from '../components/cx';
import type { PublicPlan } from './EngagementViews';

/** Storefront-themed primitives (sf-* tokens come from the business's brand). */
const sfBtn = 'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sf)] px-4 py-2.5 text-sm font-medium transition disabled:opacity-50';
const sfPrimary = `${sfBtn} bg-sf-primary text-sf-on-primary hover:opacity-90`;
const sfOutline = `${sfBtn} border border-sf-border text-sf-text hover:bg-sf-surface`;
const card = 'flex flex-col rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-4';
const control = 'h-10 w-full rounded-[var(--radius-sf)] border border-sf-border bg-sf-bg px-2 text-sm';
const alertCls = 'rounded-[var(--radius-sf)] border border-red-200 bg-red-50 p-3 text-sm text-red-800';

type Payment = { id: string; checkout_url: string; amount_minor: number; simulation: boolean };

/** Full-page navigation (hosted checkout / sign-in live outside the client router). */
function navigate(url: string) {
  window.location.assign(url);
}

function signInHref(next: string) {
  return `/auth/login?next=${encodeURIComponent(next)}`;
}

// ── «كيف عرفتِ عنا؟» (asked only when the source could not be inferred) ─────
export function AcquisitionQuestion({ slug }: { slug: string }) {
  const { t } = useI18n();
  const q = useApiQuery<{ needs_question: boolean }>(['acquisition', slug], `/api/v1/s/${slug}/acquisition`);
  const [value, setValue] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!q.data?.needs_question || done && !value) return null;
  if (done) return <p role="status" className="mt-4 text-center text-xs text-sf-muted">{t('customer.acquisition.thanks')}</p>;
  async function save() {
    if (!value) return;
    setBusy(true);
    try { await api(`/api/v1/s/${slug}/acquisition`, { body: { source: value } }); setDone(true); } catch { setDone(true); } finally { setBusy(false); }
  }
  return (
    <section aria-labelledby="acq-h" className={cx(card, 'mt-4 gap-2')}>
      <h2 id="acq-h" className="font-sf-heading text-base">{t('customer.acquisition.question')}</h2>
      <p className="text-xs text-sf-muted">{t('customer.acquisition.optional')}</p>
      <div className="flex flex-wrap gap-2">
        {HEARD_FROM.map((v) => (
          <button key={v} type="button" aria-pressed={value === v} onClick={() => setValue(v)}
            className={cx('rounded-full border px-3 py-1.5 text-xs', value === v ? 'border-sf-primary bg-sf-primary text-sf-on-primary' : 'border-sf-border')}>
            {t(`customer.acquisition.source.${v}`)}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" className={sfPrimary} disabled={!value || busy} onClick={save}>{t('actions.save')}</button>
        <button type="button" className={sfOutline} onClick={() => { setValue(''); setDone(true); }}>{t('customer.acquisition.skip')}</button>
      </div>
    </section>
  );
}

// ── Gift cards ─────────────────────────────────────────────────────────────
const AMOUNTS = [10000, 20000, 30000, 50000];
const TEMPLATES = ['classic', 'floral', 'minimal', 'celebration'] as const;

function localInputValue(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function GiftCardPurchaseForm({ slug, tenantName, signedIn, verified }: { slug: string; tenantName: string; signedIn: boolean; verified: boolean }) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const [f, setF] = useState({ amount: 20000, custom: '', template: 'classic' as (typeof TEMPLATES)[number], name: '', phone: '', email: '', message: '', when: 'now' as 'now' | 'later', at: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const amount = f.custom ? Math.round(Number(f.custom) * 100) : f.amount;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!signedIn || !verified) { navigate(signInHref(`/s/${slug}/gift-cards`)); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api<{ gift_card_id: string; payment: Payment }>(`/api/v1/s/${slug}/gift-cards/purchase`, {
        idempotencyKey: key,
        body: {
          amount_minor: amount, template_key: f.template, recipient_name: f.name.trim(),
          ...(f.phone.trim() ? { recipient_phone: f.phone.trim() } : {}), ...(f.email.trim() ? { recipient_email: f.email.trim() } : {}),
          ...(f.message.trim() ? { message: f.message.trim() } : {}),
          ...(f.when === 'later' && f.at ? { send_at: new Date(f.at).toISOString() } : {}),
        },
      });
      navigate(r.payment.checkout_url);
    } catch (e2) { setErr(e2); } finally { setBusy(false); }
  }
  const issues = err instanceof ApiError && err.code === 'validation_failed' ? (err.details?.issues as Array<{ message: string }>) : undefined;

  return (
    <div className="storefront mx-auto max-w-2xl px-4 py-6 text-sf-text">
      <h1 className="flex items-center gap-2 font-sf-heading text-2xl"><Gift className="size-6" aria-hidden />{t('customer.gift.title')}</h1>
      <p className="mb-4 text-sm text-sf-muted">{t('customer.gift.intro', { name: tenantName })}</p>
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {err ? <div role="alert" className={alertCls}>{msg(err)}{issues?.length ? <ul className="mt-1 list-disc ps-5">{issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul> : null}</div> : null}
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('customer.gift.amount')}</legend>
          <div className="flex flex-wrap gap-2">
            {AMOUNTS.map((a) => (
              <button key={a} type="button" aria-pressed={!f.custom && f.amount === a} onClick={() => set({ amount: a, custom: '' })}
                className={cx('rounded-[var(--radius-sf)] border px-4 py-2 text-sm', !f.custom && f.amount === a ? 'border-sf-primary bg-sf-primary text-sf-on-primary' : 'border-sf-border bg-sf-surface')}>
                {formatMoney(a, 'SAR', locale)}
              </button>
            ))}
            <label className="flex items-center gap-2 text-sm">
              <span className="sr-only">{t('customer.gift.custom_amount')}</span>
              <input inputMode="decimal" dir="ltr" placeholder={t('customer.gift.custom_amount')} value={f.custom} onChange={(e) => set({ custom: e.target.value.replace(/[^0-9.]/g, '') })} className={cx(control, 'w-36')} />
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('customer.gift.design')}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {TEMPLATES.map((k) => (
              <label key={k} className={cx('flex cursor-pointer items-center gap-2 rounded-[var(--radius-sf)] border p-3 text-sm', f.template === k ? 'border-sf-primary bg-sf-surface' : 'border-sf-border')}>
                <input type="radio" name="tpl" checked={f.template === k} onChange={() => set({ template: k })} />{t(`customer.gift.template.${k}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">{t('customer.gift.recipient')}</legend>
          <label className="text-sm">{t('customer.gift.recipient_name')} *<input required maxLength={80} value={f.name} onChange={(e) => set({ name: e.target.value })} className={cx(control, 'mt-1')} /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">{t('customer.gift.recipient_phone')}<input type="tel" dir="ltr" maxLength={20} value={f.phone} onChange={(e) => set({ phone: e.target.value })} className={cx(control, 'mt-1')} placeholder="05xxxxxxxx" /></label>
            <label className="text-sm">{t('customer.gift.recipient_email')}<input type="email" dir="ltr" maxLength={254} value={f.email} onChange={(e) => set({ email: e.target.value })} className={cx(control, 'mt-1')} /></label>
          </div>
          <p className="text-xs text-sf-muted">{t('customer.gift.contact_hint')}</p>
          <label className="text-sm">{t('customer.gift.message')}<textarea maxLength={300} rows={3} value={f.message} onChange={(e) => set({ message: e.target.value })} className="mt-1 w-full rounded-[var(--radius-sf)] border border-sf-border bg-sf-bg p-2 text-sm" /></label>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('customer.gift.when')}</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="when" checked={f.when === 'now'} onChange={() => set({ when: 'now' })} />{t('customer.gift.send_now')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="when" checked={f.when === 'later'} onChange={() => set({ when: 'later', at: f.at || localInputValue(new Date(Date.now() + 86_400_000)) })} />{t('customer.gift.send_later')}</label>
          {f.when === 'later' ? <input type="datetime-local" aria-label={t('customer.gift.send_at')} value={f.at} min={localInputValue(new Date())} onChange={(e) => set({ at: e.target.value })} className={cx(control, 'max-w-64')} /> : null}
          <p className="text-xs text-sf-muted">{t('customer.gift.delivery_note')}</p>
        </fieldset>
        <div className="flex items-center justify-between border-t border-sf-border pt-4 text-sm">
          <span>{t('booking.flow.total')}: <strong>{amount > 0 ? formatMoney(amount, 'SAR', locale) : '—'}</strong></span>
          <button type="submit" className={sfPrimary} disabled={busy || !f.name.trim() || (!f.phone.trim() && !f.email.trim()) || !(amount >= 1000)}>
            {signedIn && verified ? t('customer.gift.pay') : t('booking.flow.sign_in')}
          </button>
        </div>
      </form>
    </div>
  );
}

type GiftStatus = { id: string; card_status: string; initial_minor: number; code_last4: string; recipient_name: string; send_at: string; delivery_status: string; sent_at: string | null; channels: string[]; payment: { status: string; checkout_url: string | null } | null };

export function GiftPurchaseStatus({ slug, id }: { slug: string; id: string }) {
  const { t, locale, timeFormat } = useI18n();
  const q = useApiQuery<GiftStatus>(['gift-purchase', id], `/api/v1/s/${slug}/gift-cards/purchases/${id}`, { refetchInterval: 4000 });
  if (q.error) return <div className="storefront mx-auto max-w-xl px-4 py-6"><div role="alert" className={alertCls}>{t('customer.purchase.not_found')}</div></div>;
  if (!q.data) return <p role="status" className="px-4 py-10 text-center text-sm text-sf-muted">{t('customer.purchase.checking')}</p>;
  const d = q.data;
  const paid = d.card_status === 'active' || d.card_status === 'redeemed';
  return (
    <div className="storefront mx-auto max-w-xl px-4 py-6 text-sf-text">
      <div className={cx(card, 'gap-2')}>
        <h1 className="flex items-center gap-2 font-sf-heading text-xl">{paid ? <Check className="size-5" aria-hidden /> : <Gift className="size-5" aria-hidden />}{paid ? t('customer.gift.paid_title') : t('customer.purchase.awaiting')}</h1>
        <p className="text-sm">{t('customer.gift.for', { name: d.recipient_name, amount: formatMoney(d.initial_minor, 'SAR', locale) })}</p>
        {paid ? (
          <p className="text-sm text-sf-muted" role="status">
            {d.delivery_status === 'scheduled' ? t('customer.gift.scheduled', { when: formatDateTime(d.send_at, { locale, timeFormat }) })
              : d.delivery_status === 'sent' ? t('customer.gift.sent', { when: formatDateTime(d.sent_at!, { locale, timeFormat }) })
                : d.delivery_status === 'simulated' ? t('customer.gift.simulated')
                  : d.delivery_status === 'failed' ? t('customer.gift.failed') : t('customer.purchase.checking')}
          </p>
        ) : d.payment?.status === 'failed' || d.payment?.status === 'cancelled' ? (
          <p className="text-sm text-red-700">{t('customer.purchase.payment_failed')}</p>
        ) : <p className="text-sm text-sf-muted">{t('customer.purchase.redirect_note')}</p>}
        {paid ? <p className="text-xs text-sf-muted">{t('customer.gift.last4', { last4: d.code_last4 })}</p> : null}
      </div>
      <AcquisitionQuestion slug={slug} />
    </div>
  );
}

type GiftView = { recipient_name: string; message: string | null; initial_minor: number; balance_minor: number; currency: string; status: string; expires_at: string | null; template_key: string; sender_first_name: string | null; code: string | null };

/** Recipient page (server-rendered data; the link in her message is the only way in). */
export function GiftCardView({ slug, tenantName, gift }: { slug: string; tenantName: string; gift: GiftView }) {
  const { t, locale, timeFormat } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="storefront mx-auto max-w-lg px-4 py-8 text-sf-text">
      <div className="rounded-[var(--radius-sf)] bg-sf-primary p-6 text-sf-on-primary shadow-lg">
        <p className="flex items-center gap-2 text-sm opacity-90"><Sparkles className="size-4" aria-hidden />{tenantName}</p>
        <p className="mt-4 font-sf-heading text-3xl" dir="ltr">{formatMoney(gift.initial_minor, gift.currency, locale)}</p>
        <p className="mt-2 text-sm">{t('customer.gift.hello', { name: gift.recipient_name })}{gift.sender_first_name ? ` ${t('customer.gift.from', { name: gift.sender_first_name })}` : ''}</p>
        {gift.message ? <p className="mt-3 rounded-[var(--radius-sf)] bg-white/15 p-3 text-sm">«{gift.message}»</p> : null}
      </div>
      <div className={cx(card, 'mt-4 gap-2')}>
        {gift.code ? (
          <>
            <p className="text-sm text-sf-muted">{t('customer.gift.your_code')}</p>
            <p className="font-mono text-xl tracking-widest" dir="ltr">{gift.code}</p>
            <button type="button" className={cx(sfOutline, 'self-start')} onClick={() => { void navigator.clipboard?.writeText(gift.code!).then(() => setCopied(true)); }}>{copied ? t('customer.gift.copied') : t('customer.gift.copy')}</button>
          </>
        ) : <p className="text-sm">{t('customer.gift.unavailable')}</p>}
        <p className="text-sm">{t('customer.gift.balance', { amount: formatMoney(gift.balance_minor, gift.currency, locale) })}</p>
        {gift.expires_at ? <p className="text-xs text-sf-muted">{t('customer.gift.valid_until', { date: formatDateTime(gift.expires_at, { locale, timeFormat, time: false }) })}</p> : null}
        <p className="text-xs text-sf-muted">{t('customer.gift.how_to_use')}</p>
        <a href={`/s/${slug}/booking`} className={cx(sfPrimary, 'mt-2')}>{t('customer.gift.book')}</a>
      </div>
    </div>
  );
}

// ── Memberships ────────────────────────────────────────────────────────────
export function MembershipStore({ slug, plans, currency, tenantName, signedIn, verified }: { slug: string; plans: PublicPlan[]; currency: string; tenantName: string; signedIn: boolean; verified: boolean }) {
  const { t, locale, pick } = useI18n();
  const msg = useErrorMessage();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  // One idempotency key per plan for the life of the page (retries replay the same purchase).
  const keys = useRef(new Map<string, string>());
  async function buy(planId: string) {
    if (!signedIn || !verified) { navigate(signInHref(`/s/${slug}/memberships`)); return; }
    setBusyId(planId); setErr(null);
    if (!keys.current.has(planId)) keys.current.set(planId, newIdempotencyKey());
    try {
      const r = await api<{ membership_id: string; payment: Payment | null }>(`/api/v1/s/${slug}/memberships/purchase`, { body: { plan_id: planId }, idempotencyKey: keys.current.get(planId) });
      navigate(r.payment ? r.payment.checkout_url : `/s/${slug}/memberships/purchase/${r.membership_id}`);
    } catch (e) { setErr(e); } finally { setBusyId(null); }
  }
  return (
    <div className="storefront mx-auto max-w-4xl px-4 py-6 text-sf-text">
      <h1 className="font-sf-heading text-2xl">{t('engagement.memberships.title')}</h1>
      <p className="mb-4 text-sm text-sf-muted">{t('fe.store.plans_intro', { name: tenantName })}</p>
      {err ? <div role="alert" className={cx(alertCls, 'mb-4')}>{msg(err)}</div> : null}
      {!plans.length ? <p className="rounded-[var(--radius-sf)] border border-dashed border-sf-border p-6 text-center text-sm text-sf-muted">{t('fe.store.no_plans')}</p> : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {plans.map((p) => (
            <li key={p.id} className={card}>
              <p className="font-sf-heading text-lg">{pick(p.name_ar, p.name_en)}</p>
              {pick(p.description_ar, p.description_en) ? <p className="mt-1 text-sm text-sf-muted">{pick(p.description_ar, p.description_en)}</p> : null}
              <ul className="mt-3 text-sm">{p.items.map((i) => <li key={i.service_id} className="flex justify-between gap-2"><span>{pick(i.name_ar, i.name_en)}</span><span dir="ltr">× {i.sessions}</span></li>)}</ul>
              <div className="mt-3 flex items-center justify-between border-t border-sf-border pt-3 text-sm">
                <span dir="ltr" className="font-semibold">{formatMoney(p.price_minor, currency, locale)}</span>
                <span className="text-sf-muted">{t('fe.memberships.valid_for', { n: p.validity_days })}</span>
              </div>
              <button type="button" className={cx(sfPrimary, 'mt-3')} disabled={busyId === p.id} onClick={() => buy(p.id)}>
                {signedIn && verified ? t('customer.membership.buy') : t('booking.flow.sign_in')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="text-xs text-sf-muted">{t('customer.membership.online_note')}</p>
        <a href={`/s/${slug}/gift-cards`} className={sfOutline}><Gift className="size-4" aria-hidden />{t('customer.gift.cta')}</a>
      </div>
    </div>
  );
}

type MembershipStatus = { id: string; status: string; starts_at: string | null; ends_at: string | null; price_paid_minor: number; plan_snapshot: { name_ar?: string | null; name_en?: string | null }; payment: { status: string } | null };

export function MembershipPurchaseStatus({ slug, id }: { slug: string; id: string }) {
  const { t, locale, pick, timeFormat } = useI18n();
  const q = useApiQuery<MembershipStatus>(['membership-purchase', id], `/api/v1/s/${slug}/memberships/purchases/${id}`, { refetchInterval: 4000 });
  if (q.error) return <div className="storefront mx-auto max-w-xl px-4 py-6"><div role="alert" className={alertCls}>{t('customer.purchase.not_found')}</div></div>;
  if (!q.data) return <p role="status" className="px-4 py-10 text-center text-sm text-sf-muted">{t('customer.purchase.checking')}</p>;
  const d = q.data;
  const active = d.status === 'active';
  return (
    <div className="storefront mx-auto max-w-xl px-4 py-6 text-sf-text">
      <div className={cx(card, 'gap-2')}>
        <h1 className="flex items-center gap-2 font-sf-heading text-xl">{active ? <Check className="size-5" aria-hidden /> : null}{active ? t('customer.membership.active_title') : t('customer.purchase.awaiting')}</h1>
        <p className="text-sm">{pick(d.plan_snapshot.name_ar ?? null, d.plan_snapshot.name_en ?? null)} · {formatMoney(d.price_paid_minor, 'SAR', locale)}</p>
        {active && d.ends_at ? <p className="text-sm text-sf-muted">{t('customer.membership.valid_until', { date: formatDateTime(d.ends_at, { locale, timeFormat, time: false }) })}</p> : null}
        {!active && (d.payment?.status === 'failed' || d.payment?.status === 'cancelled') ? <p className="text-sm text-red-700">{t('customer.purchase.payment_failed')}</p> : null}
        {active ? <a href={`/s/${slug}/booking`} className={cx(sfPrimary, 'mt-2 self-start')}>{t('customer.gift.book')}</a> : <p className="text-sm text-sf-muted">{t('customer.purchase.redirect_note')}</p>}
      </div>
      <AcquisitionQuestion slug={slug} />
    </div>
  );
}
