'use client';

import { useMemo, type CSSProperties } from 'react';
import { DateTime } from 'luxon';
import { useI18n } from '@/i18n/client';
import { cx } from '../components/cx';
import { HOLD_STATUSES, useBookingFmt, type BookingRow, type Segment, type StaffRow } from './common';

const HOUR_PX = 56;
const HIDDEN = ['cancelled', 'expired'];

type Block = { row: BookingRow; seg: Segment; startMin: number; endMin: number; lane: number; lanes: number };

const STATUS_CLS: Record<string, string> = {
  confirmed: 'border-info/40 bg-info-bg text-ink', pending_approval: 'border-warn/50 bg-warn-bg text-ink', checked_in: 'border-luma-500 bg-luma-100 text-luma-900',
  in_service: 'border-luma-700 bg-luma-200 text-luma-900', completed: 'border-ok/40 bg-ok-bg text-ink', no_show: 'border-danger/40 bg-danger-bg text-ink',
  held: 'border-warn border-dashed bg-white text-ink', pending_payment: 'border-warn border-dashed bg-white text-ink',
};
const HOLD_STYLE: CSSProperties = { backgroundImage: 'repeating-linear-gradient(135deg, rgba(217,119,6,0.10) 0 6px, transparent 6px 12px)' };

/** Assigns side-by-side lanes to overlapping blocks within one column. */
function layout(blocks: Omit<Block, 'lane' | 'lanes'>[]): Block[] {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: Block[] = [];
  let group: Block[] = [];
  let groupEnd = -1;
  const flush = () => { const n = Math.max(1, ...group.map((g) => g.lane + 1)); for (const g of group) g.lanes = n; out.push(...group); group = []; };
  for (const b of sorted) {
    if (b.startMin >= groupEnd && group.length) flush();
    const used = new Set(group.filter((g) => g.endMin > b.startMin).map((g) => g.lane));
    let lane = 0; while (used.has(lane)) lane++;
    group.push({ ...b, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, b.endMin);
  }
  if (group.length) flush();
  return out;
}

/**
 * Day view: one column per specialist. Week view: one column per day. Blocks are
 * positioned by wall-clock time in the branch timezone; holds are hatched and dashed.
 */
export function BookingCalendar({ rows, mode, anchor, tz, staff, staffFilter, onOpen }: {
  rows: BookingRow[]; mode: 'day' | 'week'; anchor: DateTime; tz: string; staff?: StaffRow[]; staffFilter?: string; onOpen: (id: string) => void;
}) {
  const { t, pick, locale } = useI18n();
  const { time } = useBookingFmt();
  const start = anchor.setZone(tz).startOf('day');
  const days = mode === 'day' ? [start] : Array.from({ length: 7 }, (_, i) => start.plus({ days: i }));

  const segs = useMemo(() => rows.filter((r) => !HIDDEN.includes(r.status)).flatMap((row) => (row.segments ?? []).map((seg) => ({ row, seg })))
    .filter((x) => !staffFilter || x.seg.staff_id === staffFilter), [rows, staffFilter]);

  const local = (iso: string) => DateTime.fromISO(iso, { zone: tz });
  const minutesOf = (d: DateTime) => d.hour * 60 + d.minute;

  const columns = (() => {
    if (mode === 'week') return days.map((d) => ({ key: d.toISODate()!, label: d.setLocale(locale).toFormat('ccc d'), day: d, staffId: null as string | null }));
    const map = new Map<string, string>();
    for (const s of staff ?? []) if (s.is_active) map.set(s.id, pick(s.display_name, s.display_name_en));
    for (const x of segs) if (!map.has(x.seg.staff_id)) map.set(x.seg.staff_id, x.seg.staff_name);
    return [...map].filter(([id]) => !staffFilter || id === staffFilter).map(([id, name]) => ({ key: id, label: name, day: start, staffId: id as string | null }));
  })();

  const blocksFor = (col: (typeof columns)[number]) => layout(segs.filter((x) => {
    const s = local(x.seg.starts_at);
    return s.hasSame(col.day, 'day') && (col.staffId == null || x.seg.staff_id === col.staffId);
  }).map((x) => {
    const s = local(x.seg.starts_at), e = local(x.seg.ends_at);
    const endMin = e.hasSame(s, 'day') ? minutesOf(e) : 24 * 60;
    return { row: x.row, seg: x.seg, startMin: minutesOf(s), endMin: Math.max(endMin, minutesOf(s) + 15) };
  }));

  const inView = segs.filter((x) => days.some((d) => local(x.seg.starts_at).hasSame(d, 'day')));
  const firstHour = Math.min(9, ...inView.map((x) => local(x.seg.starts_at).hour));
  const lastHour = Math.max(21, ...inView.map((x) => { const e = local(x.seg.ends_at); return e.hasSame(local(x.seg.starts_at), 'day') ? Math.ceil((e.hour * 60 + e.minute) / 60) : 24; }));
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const height = hours.length * HOUR_PX;
  const now = DateTime.now().setZone(tz);
  const nowTop = (minutesOf(now) - firstHour * 60) / 60 * HOUR_PX;

  if (!columns.length) {
    return <p className="rounded-xl border border-dashed border-luma-200 bg-white/60 p-8 text-center text-sm text-ink-muted">{t('booking.dashboard.no_bookings')}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-xl border border-line bg-white" role="region" aria-label={t('booking.dashboard.calendar')} tabIndex={0}>
        <div className="flex min-w-full" style={{ width: 'max-content' }}>
          <div className="sticky start-0 z-10 w-16 shrink-0 border-e border-line bg-white">
            <div className="h-10 border-b border-line" />
            <div className="relative" style={{ height }}>
              {hours.map((h) => (
                <span key={h} className="absolute end-1 -translate-y-1/2 whitespace-nowrap text-[10px] text-ink-muted" style={{ top: (h - firstHour) * HOUR_PX }}>
                  {h === firstHour ? '' : time(start.set({ hour: h, minute: 0 }).toISO()!, tz)}
                </span>
              ))}
            </div>
          </div>
          {columns.map((col) => {
            const isToday = col.day.hasSame(now, 'day');
            return (
              <div key={col.key} className={cx('min-w-[9.5rem] flex-1 border-e border-line last:border-e-0', mode === 'week' && 'min-w-[8rem]')}>
                <div className={cx('flex h-10 items-center justify-center truncate border-b border-line px-2 text-sm font-medium', isToday && mode === 'week' && 'text-luma-800')}>{col.label}</div>
                <div className="relative" style={{ height }}>
                  {hours.map((h) => <div key={h} className="absolute inset-x-0 border-t border-line/60" style={{ top: (h - firstHour) * HOUR_PX }} aria-hidden />)}
                  {isToday && nowTop >= 0 && nowTop <= height ? <div className="absolute inset-x-0 z-[5] border-t-2 border-danger" style={{ top: nowTop }} aria-hidden /> : null}
                  {blocksFor(col).map((b) => {
                    const hold = HOLD_STATUSES.includes(b.row.status);
                    const top = (b.startMin - firstHour * 60) / 60 * HOUR_PX;
                    const h = Math.max(22, (b.endMin - b.startMin) / 60 * HOUR_PX - 2);
                    return (
                      <button key={`${b.row.id}-${b.seg.starts_at}-${b.seg.staff_id}`} type="button" onClick={() => onOpen(b.row.id)}
                        className={cx('absolute z-[6] overflow-hidden rounded-md border px-1.5 py-0.5 text-start text-[11px] leading-tight shadow-sm hover:z-[7] hover:ring-2 hover:ring-luma-300 focus:z-[7] focus:outline-none focus:ring-2 focus:ring-luma-500', STATUS_CLS[b.row.status] ?? 'border-line bg-luma-50')}
                        style={{ top, height: h, insetInlineStart: `calc(${(b.lane / b.lanes) * 100}% + 2px)`, width: `calc(${100 / b.lanes}% - 4px)`, ...(hold ? HOLD_STYLE : {}) }}
                        aria-label={`${b.row.number} · ${b.row.customer_name} · ${time(b.seg.starts_at, tz)} · ${t(`booking.status.${b.row.status}`)}${hold ? ` · ${t('bookings_ui.calendar.hold')}` : ''}`}>
                        <span className="block truncate font-semibold">{time(b.seg.starts_at, tz)}{hold ? <span className="text-warn"> · {t('bookings_ui.calendar.hold')}</span> : null}</span>
                        <span className="block truncate font-medium">{b.row.customer_name}</span>
                        <span className="block truncate text-ink-muted">{pick(b.seg.service_name_ar, b.seg.service_name_en)}</span>
                        {mode === 'week' ? <span className="block truncate text-ink-muted">{b.seg.staff_name}</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted" aria-label={t('bookings_ui.calendar.legend')}>
        {(['confirmed', 'pending_approval', 'checked_in', 'in_service', 'completed', 'no_show'] as const).map((s) => (
          <li key={s} className="flex items-center gap-1"><span className={cx('inline-block size-3 rounded-sm border', STATUS_CLS[s])} aria-hidden />{t(`booking.status.${s}`)}</li>
        ))}
        <li className="flex items-center gap-1"><span className={cx('inline-block size-3 rounded-sm border', STATUS_CLS.held)} style={HOLD_STYLE} aria-hidden />{t('bookings_ui.calendar.hold')}</li>
        <li>{t('bookings_ui.calendar.hidden_note')}</li>
      </ul>
    </div>
  );
}
