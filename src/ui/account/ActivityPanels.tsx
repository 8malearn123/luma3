'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Receipt, Star } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney, tzLabel } from '@/shared/format';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Textarea } from '../components/form';
import { Card, Tabs } from '../components/layout';
import { useToast } from '../components/toast';
import { cx } from '../components/cx';

type Item = { service_name_ar: string | null; service_name_en: string | null; staff_name: string };
type Booking = { id: string; tenant_name: string; tenant_slug: string; number: string; status: string; starts_at: string; timezone: string; total_minor: number; currency: string; items: Item[]; detail_path: string };

const statusTone = (s: string) => (s === 'confirmed' || s === 'completed' ? 'ok' : s === 'cancelled' || s === 'expired' || s === 'no_show' ? 'neutral' : 'warn');

export function BookingsPanel() {
  const { t, locale, pick, timeFormat } = useI18n();
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming');
  const q = useApiQuery<Booking[]>(['account-bookings', scope], `/api/v1/account/bookings?scope=${scope}`);
  const Chevron = locale === 'ar' ? ChevronLeft : ChevronRight;
  return (
    <div>
      <Tabs value={scope} onChange={setScope} items={[{ value: 'upcoming', label: t('account.bookings.upcoming') }, { value: 'past', label: t('account.bookings.past') }]} />
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={<CalendarDays className="size-8" aria-hidden />} title={scope === 'upcoming' ? t('account.bookings.empty_upcoming') : t('account.bookings.empty_past')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {q.data.map((b) => (
            <li key={b.id} className="rounded-2xl border border-line bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-luma-900">{b.tenant_name}</p>
                  <p className="text-sm">{formatDateTime(b.starts_at, { locale, tz: b.timezone, timeFormat, weekday: true })}</p>
                  <p className="text-xs text-ink-muted">{tzLabel(b.timezone, locale)}</p>
                </div>
                <Badge tone={statusTone(b.status)}>{t(`account.booking_status.${b.status}`)}</Badge>
              </div>
              {b.items.length ? (
                <ul className="mt-2 text-sm text-ink-muted">
                  {b.items.map((i, k) => <li key={k}>{pick(i.service_name_ar, i.service_name_en)} · {t('account.bookings.with', { name: i.staff_name })}</li>)}
                </ul>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-ink-muted">{t('account.bookings.number')}: <span dir="ltr" className="font-mono">{b.number}</span> · {formatMoney(b.total_minor, b.currency, locale)}</span>
                <Link href={b.detail_path} className="inline-flex items-center gap-1 text-luma-700 hover:underline">{t('account.bookings.details')}<Chevron className="size-4" aria-hidden /></Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Order = { id: string; tenant_name: string; number: string; status: string; total_minor: number; currency: string; created_at: string; items: Array<{ name_ar: string | null; name_en: string | null; quantity: number }> };

export function OrdersPanel() {
  const { t, locale, pick, timeFormat } = useI18n();
  const q = useApiQuery<Order[]>(['account-orders'], '/api/v1/account/orders');
  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <EmptyState icon={<Receipt className="size-8" aria-hidden />} title={t('account.orders.empty')} />;
  return (
    <ul className="flex flex-col gap-3">
      {q.data.map((o) => (
        <li key={o.id} className="rounded-2xl border border-line bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-luma-900">{o.tenant_name}</p>
              <p className="text-xs text-ink-muted">{formatDateTime(o.created_at, { locale, timeFormat })}</p>
            </div>
            <Badge tone={o.status === 'cancelled' ? 'neutral' : o.status === 'pending_payment' ? 'warn' : 'ok'}>{t(`account.order_status.${o.status}`)}</Badge>
          </div>
          <p className="mt-2 text-sm text-ink-muted">{o.items.map((i) => `${pick(i.name_ar, i.name_en)} × ${i.quantity}`).join('، ')}</p>
          <p className="mt-2 text-sm">{t('account.orders.number')}: <span dir="ltr" className="font-mono">{o.number}</span> · {formatMoney(o.total_minor, o.currency, locale)}</p>
        </li>
      ))}
    </ul>
  );
}

type Reviewable = { id: string; tenant_name: string; number: string; starts_at: string; timezone: string; items: Item[] };
type Written = { id: string; tenant_name: string; rating: number; comment: string | null; business_reply: string | null; created_at: string; is_public: boolean };

export function MyReviewsPanel() {
  const { t, locale, timeFormat } = useI18n();
  const q = useApiQuery<{ pending: Reviewable[]; written: Written[] }>(['account-reviews'], '/api/v1/account/reviews');
  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('account.reviews.pending')}>
        {d.pending.length ? <ul className="flex flex-col gap-3">{d.pending.map((b) => <ReviewForm key={b.id} b={b} />)}</ul> : <p className="text-sm text-ink-muted">{t('account.reviews.empty_pending')}</p>}
      </Card>
      <Card title={t('account.reviews.written')}>
        {d.written.length ? (
          <ul className="flex flex-col gap-3">
            {d.written.map((r) => (
              <li key={r.id} className="border-b border-line pb-3 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.tenant_name}</span><Stars n={r.rating} />
                  <span className="text-xs text-ink-muted">{formatDateTime(r.created_at, { locale, timeFormat, time: false })}</span>
                  {!r.is_public ? <Badge tone="warn">{t('account.reviews.not_public')}</Badge> : null}
                </div>
                {r.comment ? <p className="mt-1 text-sm">{r.comment}</p> : null}
                {r.business_reply ? <p className="mt-1 rounded-lg bg-luma-50 p-2 text-sm"><span className="text-xs text-luma-800">{t('reviews.reply')}: </span>{r.business_reply}</p> : null}
              </li>
            ))}
          </ul>
        ) : <EmptyState icon={<Star className="size-8" aria-hidden />} title={t('account.reviews.empty_written')} />}
      </Card>
    </div>
  );
}

function Stars({ n }: { n: number }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex text-luma-700" aria-label={t('account.reviews.stars', { n })}>
      {Array.from({ length: 5 }).map((_, i) => <Star key={i} className={cx('size-4', i < n ? 'fill-current' : 'text-luma-200')} aria-hidden />)}
    </span>
  );
}

function ReviewForm({ b }: { b: Reviewable }) {
  const { t, locale, pick, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function submit() {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/account/reviews', { body: { booking_id: b.id, rating, comment: comment.trim() || null } });
      toast({ tone: 'ok', text: t('account.reviews.thanks') });
      await qc.invalidateQueries({ queryKey: ['account-reviews'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{b.tenant_name}</p>
          <p className="text-xs text-ink-muted">{formatDateTime(b.starts_at, { locale, tz: b.timezone, timeFormat })} · {b.items.map((i) => pick(i.service_name_ar, i.service_name_en)).join('، ')}</p>
        </div>
        {!open ? <Button size="sm" variant="outline" icon={<Star className="size-4" />} onClick={() => setOpen(true)}>{t('account.reviews.write')}</Button> : null}
      </div>
      {open ? (
        <form className="mt-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <FormErrorSummary message={err ? msg(err) : null} />
          <fieldset>
            <legend className="text-sm font-medium">{t('account.reviews.rating')}</legend>
            <div className="mt-1 flex gap-1" role="radiogroup" aria-label={t('account.reviews.rating')}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={t('account.reviews.stars', { n })} onClick={() => setRating(n)} className="rounded p-1 text-luma-700 hover:bg-luma-100">
                  <Star className={cx('size-6', n <= rating ? 'fill-current' : 'text-luma-200')} aria-hidden />
                </button>
              ))}
            </div>
          </fieldset>
          <Field label={t('account.reviews.comment')}>{(p) => <Textarea {...p} rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
          <div className="flex gap-2"><Button type="submit" loading={busy} disabled={!rating}>{t('account.reviews.submit')}</Button><Button variant="ghost" onClick={() => setOpen(false)}>{t('actions.cancel')}</Button></div>
        </form>
      ) : null}
    </li>
  );
}
