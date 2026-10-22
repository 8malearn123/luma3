'use client';

import { useState } from 'react';
import { CalendarClock, Check, UsersRound } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDuration, formatMoney, tzLabel } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiMutation, useErrorMessage } from '../hooks';

/** `when_label` is formatted on the server so SSR and hydration render identical text. */
export type PublicSession = { id: string; title_ar: string | null; title_en: string | null; starts_at: string; ends_at: string; when_label: string; capacity: number; seats_left: number; price_minor: number; staff_name: string };
export type PublicPlan = { id: string; name_ar: string | null; name_en: string | null; description_ar: string | null; description_en: string | null; price_minor: number; validity_days: number; items: Array<{ service_id: string; sessions: number; name_ar?: string | null; name_en?: string | null }> };

const sfBtn = 'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sf)] px-4 py-2.5 text-sm font-medium transition disabled:opacity-50';
const sfPrimary = `${sfBtn} bg-sf-primary text-sf-on-primary hover:opacity-90`;
const card = 'flex flex-col rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-4';

/** Upcoming public group sessions with a "book a seat" action (signed-in, verified customers). */
export function GroupSessionsList({ slug, sessions, timezone, currency, signedIn, verified }: { slug: string; sessions: PublicSession[]; timezone: string; currency: string; signedIn: boolean; verified: boolean }) {
  const { t, locale, pick } = useI18n();
  return (
    <div className="storefront mx-auto max-w-4xl px-4 py-6 text-sf-text">
      <h1 className="font-sf-heading text-2xl">{t('engagement.groups.title')}</h1>
      <p className="mb-4 text-sm text-sf-muted">{t('time.tz_note', { tz: tzLabel(timezone, locale) })}</p>
      {!sessions.length ? <p className="rounded-[var(--radius-sf)] border border-dashed border-sf-border p-6 text-center text-sm text-sf-muted">{t('fe.store.no_sessions')}</p> : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {sessions.map((s) => (
            <li key={s.id} className={card}>
              <p className="font-sf-heading text-lg">{pick(s.title_ar, s.title_en)}</p>
              <p className="mt-1 flex items-center gap-1.5 text-sm"><CalendarClock className="size-4" aria-hidden />{s.when_label}</p>
              <p className="text-xs text-sf-muted">{t('engagement.groups.instructor')}: <bdi>{s.staff_name}</bdi> · {formatDuration(Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60000), locale)}</p>
              <div className="mt-3 flex items-center justify-between gap-2 text-sm">
                <span dir="ltr" className="font-semibold">{formatMoney(s.price_minor, currency, locale)}</span>
                <span className="inline-flex items-center gap-1 text-sf-muted"><UsersRound className="size-4" aria-hidden />{s.seats_left > 0 ? t('engagement.groups.seats_left', { n: s.seats_left }) : t('engagement.groups.full')}</span>
              </div>
              <SeatAction slug={slug} session={s} signedIn={signedIn} verified={verified} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-sf-muted">{t('fe.store.sessions_note')}</p>
    </div>
  );
}

function SeatAction({ slug, session, signedIn, verified }: { slug: string; session: PublicSession; signedIn: boolean; verified: boolean }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const [done, setDone] = useState<{ booking_id: string } | null>(null);
  const book = useApiMutation<void, { booking_id: string }>((_v, { idempotencyKey }) => api(`/api/v1/s/${slug}/group-sessions/${session.id}/book`, { body: { seats: 1 }, idempotencyKey }), { onSuccess: (r) => setDone(r) });
  if (done) return <p className="mt-3 flex items-center gap-1 text-sm text-sf-primary"><Check className="size-4" aria-hidden />{t('fe.store.seat_booked')} <a className="underline" href={`/account/bookings/${done.booking_id}`}>{t('account.bookings.details')}</a></p>;
  if (session.seats_left <= 0) return null;
  if (!signedIn || !verified) return <a className={`${sfPrimary} mt-3`} href={`/auth/login?next=${encodeURIComponent(`/s/${slug}/groups`)}`}>{t('fe.store.sign_in_to_book')}</a>;
  return (
    <div className="mt-3 flex flex-col gap-1">
      <button className={sfPrimary} disabled={book.isPending} aria-busy={book.isPending} onClick={() => book.mutate()}>{t('fe.store.book_seat')}</button>
      {book.error ? <p role="alert" className="text-xs text-red-700">{book.error instanceof ApiError && book.error.code === 'session_full' ? t('engagement.groups.full') : msg(book.error)}</p> : null}
      <p className="text-[11px] text-sf-muted">{t('fe.store.pay_on_site')}</p>
    </div>
  );
}

/** Public membership plans. There is no online purchase API: plans are bought at the business. */
export function MembershipPlansList({ plans, currency, tenantName }: { plans: PublicPlan[]; currency: string; tenantName: string }) {
  const { t, locale, pick } = useI18n();
  return (
    <div className="storefront mx-auto max-w-4xl px-4 py-6 text-sf-text">
      <h1 className="font-sf-heading text-2xl">{t('engagement.memberships.title')}</h1>
      <p className="mb-4 text-sm text-sf-muted">{t('fe.store.plans_intro', { name: tenantName })}</p>
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
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-sf-muted">{t('fe.store.buy_at_business')}</p>
    </div>
  );
}
