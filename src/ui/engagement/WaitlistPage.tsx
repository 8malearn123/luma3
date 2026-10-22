'use client';

import { useState } from 'react';
import { BellOff, Clock, ListOrdered } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { PageHeader, Tabs } from '../components/layout';
import { ConfirmDialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';

type Offer = { id: string; status: string; slot_start: string; slot_end: string; expires_at: string; responded_at: string | null; staff_name: string };
type Entry = {
  id: string; status: string; desired_from: string; desired_to: string; time_windows: Array<{ weekday?: number; from: string; to: string }>; notify_consent: boolean;
  created_at: string; expires_at: string; staff_name: string | null; customer_name: string; service_name_ar: string | null; service_name_en: string | null; offers: number; latest_offer: Offer | null;
};
const FILTERS = ['open', 'active', 'offered', 'fulfilled', 'expired', 'cancelled'] as const;
const TONE: Record<string, 'ok' | 'warn' | 'neutral' | 'info' | 'brand'> = { active: 'info', offered: 'warn', fulfilled: 'ok', expired: 'neutral', cancelled: 'neutral' };

export function WaitlistPage() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { when } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('open');
  const list = useApiQuery<Entry[]>(['waitlist', access.slug], access.api('/waitlist'), { refetchInterval: 60_000 });
  const [cancelling, setCancelling] = useState<Entry | null>(null);
  const canManage = !access.readOnly;
  const cancel = useApiMutation<string>((id) => api(access.api(`/waitlist/${id}`), { method: 'DELETE' }), {
    onSuccess: () => { setCancelling(null); list.refetch(); toast({ tone: 'ok', text: t('fe.waitlist.cancelled') }); },
  });
  const all = list.data ?? [];
  const rows = all.filter((e) => (filter === 'open' ? e.status === 'active' || e.status === 'offered' : e.status === filter));
  const count = (f: (typeof FILTERS)[number]) => all.filter((e) => (f === 'open' ? e.status === 'active' || e.status === 'offered' : e.status === f)).length;

  return (
    <div>
      <PageHeader title={t('engagement.waitlist.title')} subtitle={t('fe.waitlist.subtitle')} />
      <Alert tone="info" className="mb-4">{t('engagement.waitlist.policy')}</Alert>
      <Tabs value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ value: f, label: f === 'open' ? t('fe.waitlist.open') : t(`engagement.waitlist.statuses.${f}`), count: list.data ? count(f) : undefined }))} />
      {list.isLoading ? <LoadingState rows={4} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? (
        <EmptyState icon={<ListOrdered className="size-8" aria-hidden />} title={t('fe.waitlist.empty')} hint={t('fe.waitlist.empty_hint')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((e, idx) => {
            const o = e.latest_offer;
            const live = o && o.status === 'pending' && new Date(o.expires_at) > new Date();
            return (
              <li key={e.id} className="rounded-2xl border border-line bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-luma-900">{filter === 'open' ? <span className="me-1 text-xs text-ink-muted">#{idx + 1}</span> : null}{e.customer_name}</p>
                    <p className="text-sm">{pick(e.service_name_ar, e.service_name_en)}{e.staff_name ? ` · ${t('booking.flow.with', { name: e.staff_name })}` : ` · ${t('booking.flow.any_staff')}`}</p>
                  </div>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={TONE[e.status] ?? 'neutral'}>{t(`engagement.waitlist.statuses.${e.status}`)}</Badge>
                    {!e.notify_consent ? <Badge tone="neutral"><BellOff className="size-3" aria-hidden />{t('fe.waitlist.no_consent')}</Badge> : null}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div className="flex gap-2"><dt className="text-ink-muted">{t('engagement.waitlist.desired')}:</dt><dd dir="ltr">{e.desired_from}{e.desired_to !== e.desired_from ? ` → ${e.desired_to}` : ''}</dd></div>
                  {e.time_windows?.length ? <div className="flex gap-2"><dt className="text-ink-muted">{t('fe.waitlist.windows')}:</dt><dd dir="ltr">{e.time_windows.map((w) => `${w.from}–${w.to}`).join(', ')}</dd></div> : null}
                  <div className="flex gap-2"><dt className="text-ink-muted">{t('fe.waitlist.joined')}:</dt><dd>{when(e.created_at)}</dd></div>
                  <div className="flex gap-2"><dt className="text-ink-muted">{t('engagement.waitlist.offers')}:</dt><dd>{e.offers}</dd></div>
                </dl>
                {o ? (
                  <div className={`mt-3 rounded-lg border p-3 text-sm ${live ? 'border-warn/30 bg-warn-bg' : 'border-line bg-luma-50'}`}>
                    <p className="flex items-center gap-1.5 font-medium"><Clock className="size-4" aria-hidden />{t('fe.waitlist.offered_slot')}: {when(o.slot_start)} · <bdi>{t('booking.flow.with', { name: o.staff_name })}</bdi></p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {live ? t('fe.waitlist.expires_at', { time: when(o.expires_at) }) : `${t('fe.waitlist.offer_status')}: ${t(`fe.offer_status.${o.status === 'pending' ? 'expired' : o.status}`)}`}
                    </p>
                  </div>
                ) : null}
                {canManage && (e.status === 'active' || e.status === 'offered') ? (
                  <div className="mt-3 flex justify-end"><Button size="sm" variant="ghost" className="text-danger" onClick={() => setCancelling(e)}>{t('fe.waitlist.cancel')}</Button></div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog open={!!cancelling} onClose={() => setCancelling(null)} danger loading={cancel.isPending} title={t('fe.waitlist.cancel_title')}
        body={<>{cancelling ? t('fe.waitlist.cancel_body', { name: cancelling.customer_name }) : null}{cancel.error ? <p className="mt-2 text-danger">{msg(cancel.error)}</p> : null}</>}
        confirmLabel={t('fe.waitlist.cancel')} onConfirm={() => cancelling && cancel.mutate(cancelling.id)} />
    </div>
  );
}
