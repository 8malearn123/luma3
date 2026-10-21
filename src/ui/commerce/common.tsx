'use client';

import { useCallback } from 'react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney, formatNumber } from '@/shared/format';
import { Badge } from '../components/feedback';
import { useAccess } from '../shell/access-context';

export function useFmt() {
  const { locale, timeFormat } = useI18n();
  const access = useAccess();
  const money = useCallback((minor: number | null | undefined) => formatMoney(minor, access.currency, locale), [access.currency, locale]);
  const when = useCallback((v: string | Date) => formatDateTime(v, { tz: access.timezone, locale, timeFormat }), [access.timezone, locale, timeFormat]);
  const qty = useCallback((n: number) => formatNumber(n, locale, { maximumFractionDigits: 3 }), [locale]);
  return { money, when, qty };
}

const ORDER_TONES: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand'> = {
  draft: 'neutral', pending_payment: 'warn', paid: 'info', preparing: 'info', ready: 'brand', collected: 'ok', cancelled: 'danger',
};

export function OrderStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={ORDER_TONES[status] ?? 'neutral'}>{t(`commerce.orders.status.${status}`)}</Badge>;
}

export function StockBadge({ available, low }: { available: number; low?: boolean }) {
  const { t } = useI18n();
  if (available <= 0) return <Badge tone="danger">{t('commerce.products.out')}</Badge>;
  if (low) return <Badge tone="warn">{t('commerce.products.low')}</Badge>;
  return null;
}

/** Builds a query string, dropping empty values. */
export function qs(params: Record<string, string | number | undefined | null>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export function OffsetPager({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (o: number) => void }) {
  const { t } = useI18n();
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1, pages = Math.ceil(total / limit);
  return (
    <nav aria-label="pagination" className="mt-3 flex items-center justify-between text-sm">
      <button className="rounded-lg px-3 py-1.5 hover:bg-luma-100 disabled:opacity-40" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>{t('pagination.prev')}</button>
      <span className="text-ink-muted">{t('pagination.page', { n: `${page} / ${pages}` })}</span>
      <button className="rounded-lg px-3 py-1.5 hover:bg-luma-100 disabled:opacity-40" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>{t('pagination.next')}</button>
    </nav>
  );
}

/** Numeric text input that accepts Arabic-Indic digits and an optional sign. */
export function parseNum(s: string): number | null {
  const t = s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٫]/g, '.').trim();
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
