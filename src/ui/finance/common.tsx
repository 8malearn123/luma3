'use client';

import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { useI18n } from '@/i18n/client';
import { formatMoney } from '@/shared/format';
import { Field, Input, Select } from '../components/form';
import { useAccess } from '../shell/access-context';

export type Period = { preset: string; from: string; to: string };
const PRESETS = ['this_month', 'last_month', 'last_30', 'last_7', 'this_year', 'custom'] as const;

function rangeFor(preset: string, tz: string): { from: string; to: string } {
  const now = DateTime.now().setZone(tz);
  switch (preset) {
    case 'last_month': { const m = now.minus({ months: 1 }); return { from: m.startOf('month').toISODate()!, to: m.endOf('month').toISODate()! }; }
    case 'last_30': return { from: now.minus({ days: 29 }).toISODate()!, to: now.toISODate()! };
    case 'last_7': return { from: now.minus({ days: 6 }).toISODate()!, to: now.toISODate()! };
    case 'this_year': return { from: now.startOf('year').toISODate()!, to: now.toISODate()! };
    default: return { from: now.startOf('month').toISODate()!, to: now.toISODate()! };
  }
}

/** Period state shared by the finance tabs; dates are calendar days in the business timezone. */
export function usePeriod(initial = 'last_30') {
  const access = useAccess();
  const [p, setP] = useState<Period>(() => ({ preset: initial, ...rangeFor(initial, access.timezone) }));
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(p.from) && /^\d{4}-\d{2}-\d{2}$/.test(p.to) && p.from <= p.to;
  return { period: p, setPeriod: setP, valid, rangeFor: (preset: string) => rangeFor(preset, access.timezone) };
}

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <Field label={t('finance.period')} className="sm:w-48">
        {(p) => (
          <Select {...p} value={value.preset} onChange={(e) => {
            const preset = e.target.value;
            onChange(preset === 'custom' ? { ...value, preset } : { preset, ...rangeFor(preset, access.timezone) });
          }}>
            {PRESETS.map((k) => <option key={k} value={k}>{t(`fe.period.${k}`)}</option>)}
          </Select>
        )}
      </Field>
      {value.preset === 'custom' ? (
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Field label={t('fields.from')}>{(p) => <Input {...p} type="date" value={value.from} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value })} />}</Field>
          <Field label={t('fields.to')}>{(p) => <Input {...p} type="date" value={value.to} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value })} />}</Field>
        </div>
      ) : (
        <p className="pb-2 text-xs text-ink-muted" dir="ltr">{value.from} → {value.to}</p>
      )}
    </div>
  );
}

/**
 * Single-series daily bar chart in plain SVG (no chart library). Bars grow from
 * a zero baseline; hovering or focusing a bar shows its day and value; the
 * same values are available as a table for screen readers.
 */
export function DailyBars({ points, label, currency }: { points: Array<{ date: string; value: number }>; label: string; currency: string }) {
  const { t, locale } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const max = useMemo(() => Math.max(1, ...points.map((p) => p.value)), [points]);
  if (!points.length) return null;
  const W = 600, H = 160, pad = 4;
  const slot = W / points.length;
  const bw = Math.max(1, Math.min(24, slot - 2));
  const money = (v: number) => formatMoney(v, currency, locale);
  const dayLabel = (iso: string) => DateTime.fromISO(iso).setLocale(locale).toFormat('d LLL');
  const total = points.reduce((a, p) => a + p.value, 0);
  const h = hover != null ? points[hover] : null;
  return (
    <figure className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-ink-muted">
        <span>{h ? `${dayLabel(h.date)}: ` : `${t('fields.total')}: `}<span className="font-semibold text-ink" dir="ltr">{money(h ? h.value : total)}</span></span>
        <span dir="ltr">{t('fe.overview.max_day')}: {money(max === 1 && total === 0 ? 0 : max)}</span>
      </div>
      {/* The chart is drawn left-to-right in time order in both languages (dates are LTR data). */}
      <div dir="ltr" className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
          <line x1={0} x2={W} y1={H - pad} y2={H - pad} className="stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {[0.5].map((f) => <line key={f} x1={0} x2={W} y1={(H - pad) * (1 - f)} y2={(H - pad) * (1 - f)} className="stroke-luma-100" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />)}
          {points.map((p, i) => {
            const bh = p.value > 0 ? Math.max(2, ((H - pad * 2) * p.value) / max) : 0;
            const x = i * slot + (slot - bw) / 2;
            return (
              <g key={p.date} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${dayLabel(p.date)}: ${money(p.value)}`} className="outline-none">
                <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
                {bh > 0 ? <rect x={x} y={H - pad - bh} width={bw} height={bh} rx={Math.min(4, bw / 2)} className={hover === i ? 'fill-luma-800' : 'fill-luma-500'} /> : null}
              </g>
            );
          })}
        </svg>
        <div className="mt-1 flex justify-between text-[11px] text-ink-muted">
          <span>{dayLabel(points[0]!.date)}</span>
          {points.length > 2 ? <span>{dayLabel(points[Math.floor(points.length / 2)]!.date)}</span> : null}
          <span>{dayLabel(points[points.length - 1]!.date)}</span>
        </div>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>{points.map((p) => <tr key={p.date}><th scope="row">{p.date}</th><td>{money(p.value)}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}
