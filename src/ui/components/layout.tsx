'use client';

import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from './cx';
import { useI18n } from '@/i18n/client';

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-5', className)}>
      {title || actions ? <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">{title}</h2>{actions}</div> : null}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {back}
        <h1 className="text-2xl font-semibold text-luma-900">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: ReactNode; count?: number }> }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {items.map((i) => (
        <button key={i.value} role="tab" aria-selected={value === i.value} onClick={() => onChange(i.value)}
          className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm', value === i.value ? 'border-luma-700 font-semibold text-luma-800' : 'border-transparent text-ink-muted hover:text-ink')}>
          {i.label}{i.count != null ? <span className="ms-1.5 rounded-full bg-luma-100 px-1.5 text-xs">{i.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export type Column<R> = { key: string; header: ReactNode; cell: (r: R) => ReactNode; sortable?: boolean; className?: string };

export function DataTable<R>({ rows, columns, rowKey, onRowClick, sort, onSort, caption }: { rows: R[]; columns: Column<R>[]; rowKey: (r: R) => string; onRowClick?: (r: R) => void; sort?: { key: string; dir: 'asc' | 'desc' }; onSort?: (key: string) => void; caption?: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <table className="w-full text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="bg-luma-50 text-start text-xs text-ink-muted">
          <tr>{columns.map((c) => (
            <th key={c.key} scope="col" className={cx('px-3 py-2 text-start font-medium', c.className)} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
              {c.sortable && onSort ? (
                <button className="inline-flex items-center gap-1" onClick={() => onSort(c.key)}>{c.header}{sort?.key === c.key ? (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : null}</button>
              ) : c.header}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={cx('border-t border-line', onRowClick && 'cursor-pointer hover:bg-luma-50 focus-within:bg-luma-50')}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}
              tabIndex={onRowClick ? 0 : undefined}>
              {columns.map((c) => <td key={c.key} className={cx('px-3 py-2.5 align-middle', c.className)}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ hasPrev, hasNext, onPrev, onNext }: { hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void }) {
  const { t, locale } = useI18n();
  const Prev = locale === 'ar' ? ChevronRight : ChevronLeft;
  const Next = locale === 'ar' ? ChevronLeft : ChevronRight;
  return (
    <nav aria-label="pagination" className="mt-3 flex justify-between">
      <button disabled={!hasPrev} onClick={onPrev} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm hover:bg-luma-100 disabled:opacity-40"><Prev className="size-4" />{t('pagination.prev')}</button>
      <button disabled={!hasNext} onClick={onNext} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm hover:bg-luma-100 disabled:opacity-40">{t('pagination.next')}<Next className="size-4" /></button>
    </nav>
  );
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'warn' | 'ok' }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={cx('mt-1 text-2xl font-semibold', tone === 'warn' ? 'text-warn' : 'text-luma-900')}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}
