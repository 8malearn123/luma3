'use client';

import type { ReactNode } from 'react';
import { cx } from '../components/cx';

/**
 * Minimal accessible charts (CSS/SVG, no chart library). Every chart carries
 * its values as text, so nothing is conveyed by colour or shape alone.
 */

export function BarList({ items, format = (v) => String(v), label, empty }: {
  items: Array<{ key: string; label: ReactNode; value: number; hint?: ReactNode }>;
  format?: (v: number) => string;
  label: string;
  empty?: ReactNode;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {items.map((i) => (
        <li key={i.key} className="text-sm">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate">{i.label}</span>
            <span className="shrink-0 font-medium tabular-nums" dir="ltr">{format(i.value)}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-luma-100" aria-hidden>
            <div className="h-full rounded-full bg-luma-500" style={{ width: `${Math.max(2, (i.value / max) * 100)}%` }} />
          </div>
          {i.hint ? <p className="mt-0.5 text-xs text-ink-muted">{i.hint}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** Daily series as an SVG line with a visually hidden data table. */
export function Sparkline({ points, label, height = 64 }: { points: Array<{ x: string; y: number }>; label: string; height?: number }) {
  if (points.length < 2) return null;
  const w = 300;
  const max = Math.max(1, ...points.map((p) => p.y));
  const step = w / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - 4 - (p.y / max) * (height - 8)).toFixed(1)}`).join(' ');
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${height}`} className="h-16 w-full" role="img" aria-label={label} preserveAspectRatio="none">
        <path d={d} fill="none" stroke="currentColor" strokeWidth={2} className="text-luma-500" vectorEffect="non-scaling-stroke" />
      </svg>
      <table className="sr-only"><caption>{label}</caption><tbody>{points.map((p) => <tr key={p.x}><th scope="row">{p.x}</th><td>{p.y}</td></tr>)}</tbody></table>
    </figure>
  );
}

/** Stepped funnel; each step shows its count and share of the first step. */
export function Funnel({ steps, label }: { steps: Array<{ key: string; label: ReactNode; value: number }>; label: string }) {
  const first = Math.max(1, steps[0]?.value ?? 1);
  return (
    <ol aria-label={label} className="flex flex-col gap-2">
      {steps.map((s) => (
        <li key={s.key} className="text-sm">
          <div className="flex items-baseline justify-between"><span>{s.label}</span><span className="tabular-nums" dir="ltr">{s.value}</span></div>
          <div className="h-3 rounded bg-luma-100" aria-hidden><div className="h-full rounded bg-luma-300" style={{ width: `${Math.max(2, Math.min(100, (s.value / first) * 100))}%` }} /></div>
        </li>
      ))}
    </ol>
  );
}

/** Heat grid as a real table (rows = weekdays, columns = dayparts). */
export function HeatTable({ rows, cols, cell, caption }: { rows: Array<{ key: string; label: ReactNode }>; cols: Array<{ key: string; label: ReactNode }>; cell: (r: string, c: string) => number | null; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[320px] border-separate border-spacing-1 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead><tr><th scope="col" className="sr-only">—</th>{cols.map((c) => <th key={c.key} scope="col" className="px-2 text-xs font-medium text-ink-muted">{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="pe-2 text-start text-xs font-medium text-ink-muted">{r.label}</th>
              {cols.map((c) => {
                const v = cell(r.key, c.key);
                return (
                  <td key={c.key} className={cx('rounded-md px-2 py-2 text-center tabular-nums', v === null ? 'bg-white text-ink-muted' : v >= 0.85 ? 'bg-luma-700 text-white' : v >= 0.5 ? 'bg-luma-300' : v >= 0.25 ? 'bg-luma-200' : 'bg-luma-100')}>
                    {v === null ? '—' : `${Math.round(v * 100)}%`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);
