'use client';

import { useState, type ReactNode } from 'react';
import { Search, UserRound } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery, useDebounced, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, Textarea } from '../components/form';
import { Badge, Spinner } from '../components/feedback';
import { Dialog } from '../components/overlay';
import { useAccess } from '../shell/access-context';
import { cx } from '../components/cx';

/**
 * Confirmation that requires a written reason (void, reverse, cancel). Keeps the
 * text after a failure and shows the server's error inside the dialog.
 */
export function ReasonDialog({ open, onClose, onConfirm, title, body, confirmLabel, danger = true, minLength = 3, maxLength = 300 }: {
  open: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<unknown>; title: ReactNode; body?: ReactNode; confirmLabel?: string; danger?: boolean; minLength?: number; maxLength?: number;
}) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const ok = reason.trim().length >= minLength;
  async function go() {
    setBusy(true); setErr(null);
    try { await onConfirm(reason.trim()); setReason(''); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title={title} footer={<>
      <Button variant="ghost" onClick={onClose} disabled={busy}>{t('actions.cancel')}</Button>
      <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={!ok} onClick={go}>{confirmLabel ?? t('actions.confirm')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        {body ? <div className="text-ink-muted">{body}</div> : null}
        <FormErrorSummary message={err ? msg(err) : null} />
        <Field label={t('fields.reason')} required hint={t('fe.common.reason_hint', { n: minLength })}>
          {(p) => <Textarea {...p} maxLength={maxLength} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

export type CustomerLite = { id: string; display_name: string; phone: string | null; email?: string | null; has_account?: boolean };

/** Searches this business's customers (customers API) and picks one. */
export function CustomerPicker({ value, onChange, label }: { value: CustomerLite | null; onChange: (c: CustomerLite | null) => void; label?: string }) {
  const { t } = useI18n();
  const access = useAccess();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const canSearch = access.can('customers.view');
  const list = useApiQuery<{ items: CustomerLite[] }>(['fe-customers', access.slug, term], canSearch && term.length >= 2 ? access.api(`/customers?q=${encodeURIComponent(term)}&limit=8`) : null);
  if (!canSearch) return <p className="text-sm text-ink-muted">{t('fe.common.no_customer_search')}</p>;
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-luma-300 bg-luma-50 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2"><UserRound className="size-4 shrink-0 text-luma-700" aria-hidden />
          <span className="min-w-0"><span className="block truncate font-medium">{value.display_name}</span>{value.phone ? <span dir="ltr" className="block text-xs text-ink-muted">{value.phone}</span> : null}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>{t('fe.common.change')}</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Field label={label ?? t('fe.common.customer')} hint={t('fe.common.customer_search_hint')}>
        {(p) => (
          <div className="relative">
            <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-muted" aria-hidden />
            <Input {...p} className="ps-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('fe.common.customer_search')} autoComplete="off" />
          </div>
        )}
      </Field>
      {term.length >= 2 ? (
        list.isLoading ? <Spinner className="m-2" /> : list.error ? <p className="text-xs text-danger">{t('states.error')}</p> : !list.data?.items.length ? (
          <p className="text-xs text-ink-muted">{t('fe.common.no_customers')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-white" role="listbox" aria-label={t('fe.common.customer')}>
            {list.data.items.map((c) => (
              <li key={c.id}>
                <button type="button" role="option" aria-selected={false} onClick={() => { onChange(c); setQ(''); }} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-luma-50">
                  <span className="min-w-0 truncate">{c.display_name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {c.phone ? <span dir="ltr" className="text-xs text-ink-muted">{c.phone}</span> : null}
                    {c.has_account ? <Badge tone="info">{t('fe.common.has_account')}</Badge> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/** A label/value row used in detail cards. */
export function Row({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-3 py-1.5 text-sm', className)}>
      <span className="text-ink-muted">{label}</span>
      <span className="text-end font-medium">{children}</span>
    </div>
  );
}

/** Small "test value" marker for seeded/demo configuration (never legal or financial advice). */
export function TestValueBadge() {
  const { t } = useI18n();
  return <Badge tone="warn">{t('fe.common.test_value')}</Badge>;
}

/** The time the component mounted (stable across renders, keeps render pure). */
export function useMountTime() {
  const [now] = useState(() => Date.now());
  return now;
}

export const isTestLabel =(s: string | null | undefined) => !!s && /(تجريبي|test)/i.test(s);
