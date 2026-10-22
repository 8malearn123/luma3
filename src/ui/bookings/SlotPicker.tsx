'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { tzLabel } from '@/shared/format';
import { api, type ApiError } from '../api';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { IconButton } from '../components/button';
import { cx } from '../components/cx';
import { useAccess } from '../shell/access-context';
import { useBookingFmt } from './common';

export type RequestedItem = { key: string; service_id: string; variant_id?: string | null; addon_ids?: string[]; staff_id?: string | null };
export type SlotOption = {
  start: string; end: string; total_gap_min: number;
  items: Array<{ key: string; service_id: string; staff_id: string; staff_name: string; start: string; end: string; price_minor: number; duration_min: number }>;
};
type Search = { branch_id: string; timezone: string; days: Record<string, SlotOption[]>; empty_reason: string | null; next_available_date: string | null; suggestion: string | null };

const WINDOW = 7;

/**
 * Internal availability picker (POST /availability). Results are advisory: the
 * server re-validates when the hold or reschedule is submitted.
 */
export function SlotPicker({ branchId, items, timezone, value, onChange, showPrices }: {
  branchId?: string | null; items: RequestedItem[]; timezone: string; value: SlotOption | null; onChange: (o: SlotOption | null) => void; showPrices?: boolean;
}) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { time, money } = useBookingFmt();
  const today = DateTime.now().setZone(timezone).startOf('day');
  const [start, setStart] = useState(today);
  const [day, setDay] = useState<string | null>(null);
  const from = start.toISODate()!, to = start.plus({ days: WINDOW - 1 }).toISODate()!;
  const body = { branch_id: branchId ?? null, items, from, to };
  const q = useQuery<Search, ApiError>({
    queryKey: ['availability', access.slug, body],
    queryFn: ({ signal }) => api<Search>(access.api('/availability'), { body, signal, method: 'POST' }),
    enabled: items.length > 0,
    staleTime: 15_000,
  });
  const days = useMemo(() => Array.from({ length: WINDOW }, (_, i) => start.plus({ days: i })), [start]);
  const firstWithSlots = q.data ? Object.entries(q.data.days).find(([, o]) => o.length)?.[0] ?? null : null;
  const selectedDay = day && q.data?.days[day] ? day : firstWithSlots;
  const options = (selectedDay && q.data?.days[selectedDay]) || [];
  const Prev = locale === 'ar' ? ChevronRight : ChevronLeft;
  const Next = locale === 'ar' ? ChevronLeft : ChevronRight;
  const tz = q.data?.timezone ?? timezone;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <IconButton label={t('actions.previous')} disabled={start <= today} onClick={() => { setStart(start.minus({ days: WINDOW }) < today ? today : start.minus({ days: WINDOW })); setDay(null); onChange(null); }}><Prev className="size-4" /></IconButton>
        <div className="grid flex-1 grid-cols-7 gap-1">
          {days.map((d) => {
            const iso = d.toISODate()!;
            const n = q.data?.days[iso]?.length ?? 0;
            const active = iso === selectedDay;
            return (
              <button key={iso} type="button" disabled={!n} aria-pressed={active} onClick={() => { setDay(iso); onChange(null); }}
                className={cx('flex min-w-0 flex-col items-center rounded-lg border px-0.5 py-1.5 text-xs disabled:opacity-40', active ? 'border-luma-700 bg-luma-700 text-white' : 'border-line bg-white hover:bg-luma-50')}>
                <span className="truncate">{d.setLocale(locale).toFormat('ccc')}</span>
                <span className="text-sm font-semibold">{d.setLocale(locale).toFormat('d')}</span>
              </button>
            );
          })}
        </div>
        <IconButton label={t('actions.next')} onClick={() => { setStart(start.plus({ days: WINDOW })); setDay(null); onChange(null); }}><Next className="size-4" /></IconButton>
      </div>
      <p className="text-xs text-ink-muted">{t('time.tz_note', { tz: tzLabel(tz, locale) })}</p>
      {!items.length ? <p className="text-sm text-ink-muted">{t('bookings_ui.slots.pick_service_first')}</p>
        : q.isLoading ? <LoadingState rows={2} label={t('booking.flow.loading_times')} />
          : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
            : !options.length ? (
              <EmptyState title={t('booking.flow.no_times')} hint={q.data?.next_available_date ? (
                <button type="button" className="underline" onClick={() => { setStart(DateTime.fromISO(q.data!.next_available_date!, { zone: tz })); setDay(q.data!.next_available_date); }}>
                  {t('booking.flow.next_available', { date: DateTime.fromISO(q.data.next_available_date, { zone: tz }).setLocale(locale).toFormat('cccc d LLLL') })}
                </button>
              ) : q.data?.suggestion ? t('booking.flow.try_separate') : undefined} />
            ) : (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="listbox" aria-label={t('booking.flow.choose_time')}>
                {options.map((o) => {
                  const active = value?.start === o.start && value.items.every((x, i) => x.staff_id === o.items[i]?.staff_id);
                  const staff = [...new Set(o.items.map((i) => i.staff_name))].join('، ');
                  return (
                    <li key={`${o.start}-${o.items.map((i) => i.staff_id).join('-')}`}>
                      <button type="button" role="option" aria-selected={active} onClick={() => onChange(o)}
                        className={cx('flex w-full flex-col items-start rounded-lg border px-3 py-2 text-start text-sm', active ? 'border-luma-700 bg-luma-50 ring-2 ring-luma-200' : 'border-line bg-white hover:bg-luma-50')}>
                        <span className="font-semibold">{time(o.start, tz)}</span>
                        <span className="truncate text-xs text-ink-muted">{staff}</span>
                        {o.total_gap_min ? <span className="text-xs text-warn">{t('bookings_ui.slots.gap', { n: o.total_gap_min })}</span> : null}
                        {showPrices ? <span className="text-xs" dir="ltr">{money(o.items.reduce((a, i) => a + i.price_minor, 0))}</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
    </div>
  );
}
