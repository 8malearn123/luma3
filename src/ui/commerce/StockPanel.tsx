'use client';

import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, History, SlidersHorizontal } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { UNITS, unitsCompatible, type Unit } from '@/shared/units';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, Select } from '../components/form';
import { Alert, Badge, ErrorState, Spinner } from '../components/feedback';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { parseNum, useFmt } from './common';

type Movement = { id: string; kind: string; quantity: number; on_hand_after: number; reserved_after: number; reason: string | null; ref_type: string | null; created_at: string; actor_name: string | null };

/** Receive / adjust stock for one inventory item, plus its paginated movement history. */
export function StockPanel({ itemId, unit, onHand, reserved, canManage, onChanged }: { itemId: string; unit: Unit; onHand: number; reserved: number; canManage: boolean; onChanged?: () => void }) {
  const { t } = useI18n();
  const { qty, when } = useFmt();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'receipt' | 'adjustment' | null>(null);
  const [amount, setAmount] = useState('');
  const [inUnit, setInUnit] = useState<Unit>(unit);
  const [reason, setReason] = useState('');
  const [bookingItem, setBookingItem] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [errText, setErrText] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const history = useInfiniteQuery({
    queryKey: ['movements', access.slug, itemId],
    enabled: showHistory,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api<{ items: Movement[]; next_cursor: string | null }>(access.api(`/inventory/items/${itemId}/movements?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`), { signal }),
    getNextPageParam: (last) => last.next_cursor,
  });

  async function submit() {
    setErr(null); setErrText(null);
    const q = parseNum(amount);
    if (q === null || q === 0) { setErrText(`${t('commerce.inventory.quantity')}: ${t('fields.required')}`); return; }
    setBusy(true);
    try {
      const body = mode === 'receipt'
        ? { kind: 'receipt', quantity: q, unit: inUnit, ...(reason ? { reason } : {}) }
        : { kind: 'adjustment', quantity: q, unit: inUnit, reason, ...(bookingItem ? { booking_item_id: bookingItem.trim() } : {}) };
      await api(access.api(`/inventory/items/${itemId}/movements`), { body });
      toast({ tone: 'ok', text: t('commerce.inventory.recorded') });
      setMode(null); setAmount(''); setReason(''); setBookingItem('');
      qc.invalidateQueries({ queryKey: ['movements', access.slug, itemId] });
      onChanged?.();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const compatible = UNITS.filter((u) => unitsCompatible(u, unit));
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-3 gap-2 text-center text-sm">
        <div className="rounded-lg bg-luma-50 p-2"><dt className="text-xs text-ink-muted">{t('commerce.products.on_hand')}</dt><dd className="font-semibold">{qty(onHand)} {t(`commerce.inventory.unit.${unit}`)}</dd></div>
        <div className="rounded-lg bg-luma-50 p-2"><dt className="text-xs text-ink-muted">{t('commerce.products.reserved')}</dt><dd className="font-semibold">{qty(reserved)}</dd></div>
        <div className="rounded-lg bg-luma-50 p-2"><dt className="text-xs text-ink-muted">{t('commerce.products.available')}</dt><dd className="font-semibold">{qty(onHand - reserved)}</dd></div>
      </dl>
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={mode === 'receipt' ? 'primary' : 'outline'} icon={<ArrowDownToLine className="size-4" />} onClick={() => setMode(mode === 'receipt' ? null : 'receipt')}>{t('commerce.inventory.receive')}</Button>
          <Button size="sm" variant={mode === 'adjustment' ? 'primary' : 'outline'} icon={<SlidersHorizontal className="size-4" />} onClick={() => setMode(mode === 'adjustment' ? null : 'adjustment')}>{t('commerce.inventory.adjust')}</Button>
          <Button size="sm" variant="ghost" icon={<History className="size-4" />} onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>{t('commerce.inventory.history')}</Button>
        </div>
      ) : <Button size="sm" variant="ghost" icon={<History className="size-4" />} onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>{t('commerce.inventory.history')}</Button>}

      {mode ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
          <FormErrorSummary message={errText ?? (err ? msg(err) : null)} />
          {mode === 'adjustment' ? <p className="text-xs text-ink-muted">{t('commerce.inventory.adjust_hint')}</p> : null}
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('commerce.inventory.quantity')} required>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
            <Field label={t('commerce.inventory.in_unit')}>{(p) => (
              <Select {...p} value={inUnit} onChange={(e) => setInUnit(e.target.value as Unit)} disabled={compatible.length < 2}>
                {compatible.map((u) => <option key={u} value={u}>{t(`commerce.inventory.unit.${u}`)}</option>)}
              </Select>
            )}</Field>
          </div>
          <Field label={t('commerce.inventory.reason')} required={mode === 'adjustment'} hint={mode === 'adjustment' ? t('commerce.inventory.reason_required') : undefined}>
            {(p) => <Input {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          {mode === 'adjustment' ? (
            <Field label={t('commerce.inventory.booking_item')} hint={t('commerce.inventory.booking_item_hint')}>{(p) => <Input {...p} dir="ltr" value={bookingItem} onChange={(e) => setBookingItem(e.target.value)} />}</Field>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setMode(null)}>{t('actions.cancel')}</Button>
            <Button size="sm" loading={busy} disabled={mode === 'adjustment' && reason.trim().length < 3} onClick={submit}>{t('actions.save')}</Button>
          </div>
        </div>
      ) : null}

      {showHistory ? (
        <section aria-label={t('commerce.inventory.history')} className="flex flex-col gap-2">
          {history.isLoading ? <Spinner /> : history.error ? <ErrorState error={history.error} onRetry={() => history.refetch()} /> : null}
          {history.data && history.data.pages[0]!.items.length === 0 ? <p className="text-sm text-ink-muted">{t('commerce.inventory.no_history')}</p> : null}
          <ol className="flex flex-col divide-y divide-line rounded-xl border border-line">
            {history.data?.pages.flatMap((p) => p.items).map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge tone={m.quantity < 0 || m.kind === 'reservation' ? 'warn' : 'ok'}>{t(`commerce.inventory.movement.${m.kind}`)}</Badge>
                    <span dir="ltr" className="font-medium">{m.quantity > 0 ? '+' : ''}{qty(m.quantity)}</span>
                  </div>
                  {m.reason ? <p className="mt-0.5 text-xs text-ink-muted">{m.reason}</p> : null}
                  <p className="text-xs text-ink-muted">{t('commerce.inventory.after', { on_hand: qty(m.on_hand_after), reserved: qty(m.reserved_after) })}</p>
                </div>
                <div className="shrink-0 text-end text-xs text-ink-muted">
                  <p>{when(m.created_at)}</p>
                  <p>{m.actor_name ?? t('commerce.orders.system')}</p>
                </div>
              </li>
            ))}
          </ol>
          {history.hasNextPage ? <Button variant="ghost" size="sm" loading={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>{t('commerce.inventory.load_more')}</Button> : null}
          {!canManage ? <Alert tone="info">{t('commerce.inventory.denied_adjust')}</Alert> : null}
        </section>
      ) : null}
    </div>
  );
}
