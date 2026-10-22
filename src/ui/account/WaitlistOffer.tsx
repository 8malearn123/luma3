'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CalendarClock, Check, Hourglass, Store, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatDuration, formatMoney, tzLabel } from '@/shared/format';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { ConfirmDialog } from '../components/overlay';

type Offer = {
  id: string; status: 'pending' | 'accepted' | 'declined' | 'expired' | 'superseded'; slot_start: string; slot_end: string; expires_at: string; booking_id: string | null;
  staff_name: string; service_name_ar: string | null; service_name_en: string | null; price_minor: number; price_display: string; timezone: string; tenant_name: string; tenant_slug: string;
};

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function remaining(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
}

export function WaitlistOffer({ id }: { id: string }) {
  const { t, locale, pick, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const router = useRouter();
  const q = useApiQuery<Offer>(['waitlist-offer', id], `/api/v1/account/waitlist/offers/${id}`);
  const o = q.data;
  const pending = o?.status === 'pending';
  const now = useNow(!!pending);
  const left = o ? Date.parse(o.expires_at) - now : 0;
  const expired = !!o && (o.status === 'expired' || (pending && left <= 0));
  const [declining, setDeclining] = useState(false);
  const accept = useApiMutation<void, { booking_id: string; tenant_slug: string }>((_v, { idempotencyKey }) => api(`/api/v1/account/waitlist/offers/${id}/accept`, { body: {}, idempotencyKey }), {
    onSuccess: (r) => { router.push(`/s/${r.tenant_slug}/checkout/booking/${r.booking_id}`); },
  });
  const decline = useApiMutation<void>(() => api(`/api/v1/account/waitlist/offers/${id}/decline`, { body: {} }), { onSuccess: () => { setDeclining(false); q.refetch(); } });

  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.error || !o) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const when = (v: string) => formatDateTime(v, { tz: o.timezone, locale, timeFormat, weekday: true });
  const minutes = Math.round((Date.parse(o.slot_end) - Date.parse(o.slot_start)) / 60000);
  const status = expired ? 'expired' : o.status;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs text-ink-muted">{t('fe.offer.title')}</p>
            <Link href={`/s/${o.tenant_slug}`} className="inline-flex items-center gap-1 font-semibold text-luma-900 hover:underline"><Store className="size-4" aria-hidden />{o.tenant_name}</Link>
          </div>
          <Badge tone={status === 'pending' ? 'warn' : status === 'accepted' ? 'ok' : 'neutral'}>{t(`fe.offer_status.${status}`)}</Badge>
        </div>
        <div className="mt-4 flex flex-col gap-1">
          <p className="text-lg font-medium">{pick(o.service_name_ar, o.service_name_en)}</p>
          <p className="flex items-center gap-1.5"><CalendarClock className="size-4 text-luma-700" aria-hidden />{when(o.slot_start)}</p>
          <p className="text-sm text-ink-muted"><bdi>{t('account.bookings.with', { name: o.staff_name })}</bdi> · <bdi>{formatDuration(minutes, locale)}</bdi> · {o.price_display === 'starting_from' ? `${t('fe.offer.from_price')} ` : ''}<span dir="ltr">{formatMoney(o.price_minor, 'SAR', locale)}</span></p>
          <p className="text-xs text-ink-muted">{t('time.tz_note', { tz: tzLabel(o.timezone, locale) })}</p>
        </div>

        {status === 'pending' ? (
          <>
            <div role="timer" aria-live="off" className="mt-4 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn-bg p-3">
              <Hourglass className="size-5 text-warn" aria-hidden />
              <div>
                <p className="text-sm font-medium">{t('fe.offer.expires_in')} <span dir="ltr" className="font-mono text-base tabular-nums">{remaining(left)}</span></p>
                <p className="text-xs text-ink-muted">{t('fe.offer.until', { time: formatDateTime(o.expires_at, { tz: o.timezone, locale, timeFormat }) })}</p>
              </div>
            </div>
            <p className="mt-3 text-xs text-ink-muted">{t('fe.offer.accept_note')}</p>
            {accept.error ? <Alert tone="danger" className="mt-3">{msg(accept.error)}</Alert> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button icon={<Check className="size-4" />} loading={accept.isPending} onClick={() => accept.mutate()}>{t('fe.offer.accept')}</Button>
              <Button variant="ghost" icon={<X className="size-4" />} disabled={accept.isPending} onClick={() => setDeclining(true)}>{t('fe.offer.decline')}</Button>
            </div>
          </>
        ) : status === 'accepted' && o.booking_id ? (
          <Alert tone="ok" className="mt-4">{t('fe.offer.accepted_note')} <Link href={`/account/bookings/${o.booking_id}`} className="font-semibold underline">{t('account.bookings.details')}</Link></Alert>
        ) : (
          <Alert tone="info" className="mt-4">{t(`fe.offer.closed_${status === 'declined' ? 'declined' : 'expired'}`)}</Alert>
        )}
      </Card>
      <ConfirmDialog open={declining} onClose={() => setDeclining(false)} danger loading={decline.isPending} title={t('fe.offer.decline_title')}
        body={<>{t('fe.offer.decline_body')}{decline.error ? <p className="mt-2 text-danger">{msg(decline.error)}</p> : null}</>}
        confirmLabel={t('fe.offer.decline')} onConfirm={() => decline.mutate()} />
    </div>
  );
}
