'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, CheckCircle2, MapPin, PartyPopper, UsersRound } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney } from '@/shared/format';
import { EVENT_OCCASIONS } from '@/shared/schemas/events';
import { api, ApiError, newIdempotencyKey } from '../api';
import { useApiMutation, useErrorMessage } from '../hooks';

const sfBtn = 'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sf)] px-4 py-2.5 text-sm font-medium transition disabled:opacity-50';
const sfPrimary = `${sfBtn} bg-sf-primary text-sf-on-primary hover:opacity-90`;
const sfOutline = `${sfBtn} border border-sf-border hover:bg-sf-surface`;
const card = 'flex flex-col rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-4';
const inputCls = 'w-full rounded-[var(--radius-sf)] border border-sf-border bg-white px-3 py-2 text-sm text-black focus-visible:outline-2 focus-visible:outline-sf-primary';

export type EventFormService = { id: string; name_ar: string | null; name_en: string | null };
type Mine = { id: string; number: string; status: string; occasion: string; starts_at: string; timezone: string; people_count: number; total_minor: number | null; currency: string };

/** Public request form («اطلبي عرض سعر») plus the signed-in customer's requests. */
export function EventRequestView({ slug, services, maxPeople, freeCancellationDays, intro, signedIn, verified, minDate }: {
  slug: string; services: EventFormService[]; maxPeople: number; freeCancellationDays: number; intro: string | null; signedIn: boolean; verified: boolean; minDate: string;
}) {
  const { t, pick, locale } = useI18n();
  const msg = useErrorMessage();
  const router = useRouter();
  const [f, setF] = useState({ occasion: 'wedding', event_date: '', start_time: '16:00', location_type: 'venue', location_text: '', people_count: '1', service_ids: [] as string[], notes: '', contact_phone: '' });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const [mine, setMine] = useState<Mine[] | null>(null);
  const loadMine = useCallback(async () => { if (signedIn) { try { setMine(await api<Mine[]>(`/api/v1/s/${slug}/event-requests`)); } catch { setMine([]); } } }, [slug, signedIn]);
  useEffect(() => { loadMine(); }, [loadMine]);
  const send = useApiMutation<void, { id: string }>((_v, { idempotencyKey }) => api(`/api/v1/s/${slug}/event-requests`, {
    idempotencyKey, body: {
      occasion: f.occasion, event_date: f.event_date, start_time: f.start_time, location_type: f.location_type, location_text: f.location_type === 'venue' ? f.location_text.trim() : (f.location_text.trim() || null),
      people_count: Number(f.people_count), service_ids: f.service_ids, notes: f.notes.trim() || null, contact_phone: f.contact_phone.trim() || null,
    },
  }), { onSuccess: (r) => router.push(`/s/${slug}/events/${r.id}`) });
  const people = Number(f.people_count);
  const ok = !!f.event_date && !!f.start_time && people >= 1 && people <= maxPeople && (f.location_type !== 'venue' || !!f.location_text.trim());
  const issues = send.error instanceof ApiError && send.error.code === 'validation_failed' ? (send.error.details?.issues as Array<{ path: string }>) : [];
  const label = (k: string, children: React.ReactNode, id: string, hint?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">{k}</label>
      {children}
      {hint ? <p className="text-xs text-sf-muted">{hint}</p> : null}
    </div>
  );

  return (
    <div className="storefront mx-auto max-w-3xl px-4 py-6 text-sf-text">
      <div className="mb-4 flex items-center gap-2"><PartyPopper className="size-6 text-sf-primary" aria-hidden /><h1 className="font-sf-heading text-2xl">{t('expert.sf.title')}</h1></div>
      <p className="mb-4 text-sm text-sf-muted">{intro || t('expert.sf.intro')}</p>
      {mine?.length ? (
        <section aria-labelledby="my-events" className="mb-6">
          <h2 id="my-events" className="mb-2 font-sf-heading text-lg">{t('expert.sf.my_requests')}</h2>
          <ul className="flex flex-col gap-2">
            {mine.map((m) => (
              <li key={m.id}><a href={`/s/${slug}/events/${m.id}`} className={`${card} !flex-row items-center justify-between gap-2 hover:border-sf-primary`}>
                <span>{t(`expert.occasions.${m.occasion}`)} · {formatDateTime(m.starts_at, { tz: m.timezone, locale })}</span>
                <span className="text-xs font-medium">{t(`expert.sf.status.${m.status}`)}</span>
              </a></li>
            ))}
          </ul>
        </section>
      ) : null}
      {!signedIn || !verified ? (
        <div className={card}>
          <p className="mb-3 text-sm">{t('expert.sf.sign_in')}</p>
          <a className={sfPrimary} href={`/auth/login?next=${encodeURIComponent(`/s/${slug}/events`)}`}>{t('fe.store.sign_in_to_book')}</a>
        </div>
      ) : (
        <form className={`${card} gap-4`} onSubmit={(e) => { e.preventDefault(); if (ok) send.mutate(); }} noValidate>
          {label(t('expert.sf.occasion'), (
            <select id="ev-occ" className={inputCls} value={f.occasion} onChange={(e) => set({ occasion: e.target.value })}>
              {EVENT_OCCASIONS.map((o) => <option key={o} value={o}>{t(`expert.occasions.${o}`)}</option>)}
            </select>
          ), 'ev-occ')}
          <div className="grid gap-4 sm:grid-cols-2">
            {label(t('expert.sf.date'), <input id="ev-date" type="date" required min={minDate} className={inputCls} value={f.event_date} onChange={(e) => set({ event_date: e.target.value })} aria-invalid={issues.some((i) => i.path === 'event_date')} />, 'ev-date')}
            {label(t('expert.sf.time'), <input id="ev-time" type="time" required step={900} className={inputCls} value={f.start_time} onChange={(e) => set({ start_time: e.target.value })} />, 'ev-time', t('expert.sf.time_hint'))}
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('expert.sf.location')}</legend>
            <div className="flex flex-wrap gap-4">
              {(['venue', 'studio'] as const).map((v) => (
                <label key={v} className="inline-flex items-center gap-2 text-sm"><input type="radio" name="loc" value={v} checked={f.location_type === v} onChange={() => set({ location_type: v })} />{t(`expert.events.location.${v}`)}</label>
              ))}
            </div>
            {f.location_type === 'venue' ? (
              <input aria-label={t('expert.sf.venue')} placeholder={t('expert.sf.venue_placeholder')} required maxLength={300} className={inputCls} value={f.location_text} onChange={(e) => set({ location_text: e.target.value })} />
            ) : null}
          </fieldset>
          {label(t('expert.sf.people'), <input id="ev-people" type="number" min={1} max={maxPeople} required className={inputCls} value={f.people_count} onChange={(e) => set({ people_count: e.target.value })} />, 'ev-people', t('expert.sf.people_hint', { n: maxPeople }))}
          {services.length ? (
            <fieldset>
              <legend className="mb-1 text-sm font-medium">{t('expert.sf.services')}</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {services.map((s) => (
                  <label key={s.id} className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={f.service_ids.includes(s.id)} onChange={(e) => set({ service_ids: e.target.checked ? [...f.service_ids, s.id].slice(0, 20) : f.service_ids.filter((x) => x !== s.id) })} />
                    {pick(s.name_ar, s.name_en)}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          {label(t('expert.sf.notes'), <textarea id="ev-notes" rows={4} maxLength={2000} className={inputCls} value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder={t('expert.sf.notes_placeholder')} />, 'ev-notes')}
          {label(t('expert.sf.phone'), <input id="ev-phone" type="tel" dir="ltr" maxLength={30} className={inputCls} value={f.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} />, 'ev-phone', t('expert.sf.phone_hint'))}
          <p className="text-xs text-sf-muted">{t('expert.sf.how_it_works', { days: freeCancellationDays })}</p>
          {send.error ? <p role="alert" className="text-sm text-red-700">{send.error instanceof ApiError && send.error.code === 'too_many_people' ? t('expert.sf.people_hint', { n: maxPeople }) : msg(send.error)}</p> : null}
          <button type="submit" className={sfPrimary} disabled={!ok || send.isPending} aria-busy={send.isPending}>{t('expert.sf.submit')}</button>
        </form>
      )}
    </div>
  );
}

type Detail = {
  id: string; number: string; status: string; occasion: string; starts_at: string; ends_at: string | null; timezone: string; location_type: string; location_text: string | null;
  people_count: number; notes: string | null; subtotal_minor: number | null; tax_minor: number | null; total_minor: number | null; deposit_minor: number | null; currency: string;
  quote_note: string | null; quote_expires_at: string | null; quote_version: number; paid_minor: number; refunded_minor: number; balance_due_minor: number | null; staff_name: string | null;
  free_cancellation_days: number | null; can_accept: boolean; can_cancel: boolean; decline_reason: string | null; cancel_source: string | null;
};

/** The customer's request, the quote, deposit payment and cancellation. */
export function EventDetailView({ slug, id }: { slug: string; id: string }) {
  const { t, locale, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const [e, setE] = useState<Detail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [now] = useState(() => Date.now());
  const load = useCallback(async () => { try { setE(await api<Detail>(`/api/v1/s/${slug}/event-requests/${id}`)); } catch (x) { setErr(x); } }, [slug, id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);
  // Returning from the provider: the redirect is not proof of payment — poll the server state briefly.
  useEffect(() => {
    if (e?.status !== 'pending_payment') return;
    const h = setTimeout(load, 2000);
    return () => clearTimeout(h);
  }, [e, load]);

  if (err && !e) return <div className="storefront mx-auto max-w-2xl px-4 py-10 text-center"><p role="alert">{msg(err)}</p></div>;
  if (!e) return <div className="storefront mx-auto max-w-2xl px-4 py-10 text-center"><p role="status">{t('states.loading')}</p></div>;
  const money = (m: number | null | undefined) => formatMoney(m, e.currency, locale);
  const when = (v: string) => formatDateTime(v, { tz: e.timezone, locale, timeFormat, weekday: true });

  const accept = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ payment: { checkout_url: string } }>(`/api/v1/s/${slug}/event-requests/${id}/accept`, { body: { quote_version: e.quote_version }, idempotencyKey: key });
      window.location.href = r.payment.checkout_url;
    } catch (x) { setErr(x); setBusy(false); if (x instanceof ApiError && (x.code === 'quote_changed' || x.code === 'quote_expired')) load(); }
  };
  const cancel = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/v1/s/${slug}/event-requests/${id}/cancel`, { body: { reason: reason.trim() } }); setCancelling(false); await load(); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const lateCancel = e.status === 'confirmed' && e.free_cancellation_days != null && Date.parse(e.starts_at) - now < e.free_cancellation_days * 86_400_000;

  return (
    <div className="storefront mx-auto max-w-2xl px-4 py-6 text-sf-text">
      <h1 className="font-sf-heading text-2xl">{t(`expert.occasions.${e.occasion}`)}</h1>
      <p className="mb-4 text-sm text-sf-muted" dir="ltr">{e.number}</p>
      <div className={`${card} gap-2`}>
        <p className="font-medium" role="status">{t(`expert.sf.status_long.${e.status}`)}</p>
        <p className="flex items-center gap-2 text-sm"><CalendarClock className="size-4" aria-hidden />{when(e.starts_at)}</p>
        <p className="flex items-center gap-2 text-sm"><MapPin className="size-4" aria-hidden />{t(`expert.events.location.${e.location_type}`)}{e.location_text ? ` — ${e.location_text}` : ''}</p>
        <p className="flex items-center gap-2 text-sm"><UsersRound className="size-4" aria-hidden />{t('expert.events.people', { n: e.people_count })}</p>
        {e.decline_reason ? <p className="text-sm">{e.decline_reason}</p> : null}
      </div>
      {e.total_minor != null && !['declined'].includes(e.status) ? (
        <section aria-labelledby="quote-h" className={`${card} mt-4 gap-2`}>
          <h2 id="quote-h" className="font-sf-heading text-lg">{t('expert.sf.quote')}</h2>
          {e.staff_name ? <p className="text-sm">{t('expert.events.specialist')}: <bdi>{e.staff_name}</bdi></p> : null}
          {e.ends_at ? <p className="text-sm">{t('expert.sf.until', { when: when(e.ends_at) })}</p> : null}
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
            <dt>{t('expert.events.total')}</dt><dd dir="ltr" className="font-semibold">{money(e.total_minor)}</dd>
            {e.tax_minor ? <><dt className="text-xs text-sf-muted">{t('expert.events.tax_included')}</dt><dd dir="ltr" className="text-xs text-sf-muted">{money(e.tax_minor)}</dd></> : null}
            <dt>{t('expert.sf.deposit_now')}</dt><dd dir="ltr" className="font-semibold text-sf-primary">{money(e.deposit_minor)}</dd>
            <dt>{t('expert.sf.balance_on_day')}</dt><dd dir="ltr">{money((e.total_minor ?? 0) - (e.deposit_minor ?? 0))}</dd>
            {e.paid_minor ? <><dt>{t('expert.events.paid')}</dt><dd dir="ltr">{money(e.paid_minor)}</dd></> : null}
            {e.refunded_minor ? <><dt>{t('expert.events.refunded')}</dt><dd dir="ltr">{money(e.refunded_minor)}</dd></> : null}
          </dl>
          {e.quote_note ? <p className="whitespace-pre-line rounded-[var(--radius-sf)] bg-white/60 p-2 text-sm">{e.quote_note}</p> : null}
          {e.status === 'quoted' && e.quote_expires_at ? <p className="text-xs text-sf-muted">{t('expert.sf.valid_until', { when: when(e.quote_expires_at) })}</p> : null}
          {e.free_cancellation_days != null ? <p className="text-xs text-sf-muted">{t('expert.sf.policy', { days: e.free_cancellation_days })}</p> : null}
          {e.can_accept ? <button type="button" className={`${sfPrimary} mt-2`} disabled={busy} aria-busy={busy} onClick={accept}>{t('expert.sf.accept_pay', { amount: money(e.deposit_minor) })}</button> : null}
          {e.status === 'confirmed' ? <p className="mt-1 flex items-center gap-1 text-sm text-sf-primary"><CheckCircle2 className="size-4" aria-hidden />{t('expert.sf.confirmed_note')}</p> : null}
        </section>
      ) : null}
      {err ? <p role="alert" className="mt-3 text-sm text-red-700">{err instanceof ApiError && err.code === 'quote_changed' ? t('expert.sf.quote_changed') : msg(err)}</p> : null}
      {e.can_cancel ? (
        cancelling ? (
          <div className={`${card} mt-4 gap-2`}>
            <label htmlFor="ev-reason" className="text-sm font-medium">{t('expert.sf.cancel_reason')}</label>
            <textarea id="ev-reason" rows={2} maxLength={500} className={inputCls} value={reason} onChange={(x) => setReason(x.target.value)} />
            {lateCancel ? <p className="text-xs text-red-700">{t('expert.sf.late_cancel_warning')}</p> : null}
            <div className="flex gap-2">
              <button type="button" className={sfPrimary} disabled={busy || reason.trim().length < 3} onClick={cancel}>{t('expert.sf.confirm_cancel')}</button>
              <button type="button" className={sfOutline} onClick={() => setCancelling(false)}>{t('actions.back')}</button>
            </div>
          </div>
        ) : <button type="button" className={`${sfOutline} mt-4`} onClick={() => setCancelling(true)}>{t('expert.sf.cancel')}</button>
      ) : null}
      <p className="mt-6 text-sm"><a className="underline" href={`/s/${slug}/events`}>{t('expert.sf.back')}</a></p>
    </div>
  );
}
