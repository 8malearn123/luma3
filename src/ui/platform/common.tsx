'use client';

import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney } from '@/shared/format';
import { Badge } from '../components/feedback';
import { Input } from '../components/form';

const SUB_TONES: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  trialing: 'info', active: 'ok', past_due: 'warn', paused: 'neutral', cancelled: 'danger', expired: 'danger',
};
export function SubStatus({ status }: { status: string | null | undefined }) {
  const { t } = useI18n();
  if (!status) return <Badge>{t('platform.none')}</Badge>;
  return <Badge tone={SUB_TONES[status] ?? 'neutral'}>{t(`platform.sub_status.${status}`)}</Badge>;
}

const TENANT_TONES: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = { onboarding: 'info', active: 'ok', suspended: 'danger', closed: 'neutral' };
export function TenantStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={TENANT_TONES[status] ?? 'neutral'}>{t(`platform.tenant_status.${status}`)}</Badge>;
}

export function TestBadge() {
  const { t } = useI18n();
  return <Badge tone="warn">{t('platform.test_label')}</Badge>;
}

export function When({ v, time = true }: { v: string | Date | null | undefined; time?: boolean }) {
  const { locale, timeFormat } = useI18n();
  if (!v) return <span className="text-ink-muted">—</span>;
  return <time dateTime={new Date(v).toISOString()}>{formatDateTime(v, { locale, timeFormat, time })}</time>;
}

export function Money({ minor, currency = 'SAR' }: { minor: number | null | undefined; currency?: string }) {
  const { locale, t } = useI18n();
  if (minor == null) return <span className="text-ink-muted">{t('platform.pricing_not_configured')}</span>;
  return <span dir="ltr">{formatMoney(minor, currency, locale)}</span>;
}

export function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="relative min-w-48 flex-1">
      <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-muted" aria-hidden />
      <Input aria-label={label} placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} className="ps-9" />
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-end gap-2">{children}</div>;
}

export function PageNav({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (p: number) => void }) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav aria-label="pagination" className="mt-3 flex items-center justify-between text-sm">
      <span className="text-ink-muted">{t('platform.page_of', { page, pages, total })}</span>
      <div className="flex gap-1">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded-lg px-3 py-1.5 hover:bg-luma-100 disabled:opacity-40">{t('pagination.prev')}</button>
        <button disabled={page >= pages} onClick={() => onPage(page + 1)} className="rounded-lg px-3 py-1.5 hover:bg-luma-100 disabled:opacity-40">{t('pagination.next')}</button>
      </div>
    </nav>
  );
}

export function KV({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line py-2 text-sm last:border-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-end font-medium">{children}</dd>
    </div>
  );
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}
