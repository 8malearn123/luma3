'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, PackageCheck, PackageOpen, Undo2, XCircle } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Checkbox, Field, FormErrorSummary, Input } from '../components/form';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { ConfirmDialog, Dialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { OrderStatusBadge, useFmt } from './common';

type Order = {
  id: string; number: string; status: string; refund_status: string; fulfillment_method: string; booking_number: string | null;
  subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number; paid_minor: number; refunded_minor: number; currency: string;
  customer_name: string; customer_phone: string | null; customer_email: string | null; customer_note: string | null; expires_at: string | null; created_at: string;
  coupon: { code: string } | null;
  items: Array<{ id: string; name_ar: string | null; name_en: string | null; variant_name_ar: string | null; variant_name_en: string | null; sku: string | null; unit_price_minor: number; quantity: number; line_total_minor: number; returnable: boolean; unit_cost_minor?: number | null }>;
  payments: Array<{ id: string; kind: string; method: string; amount_minor: number; status: string; created_at: string }>;
  events: Array<{ id: string; kind: string; from_status: string | null; to_status: string | null; reason: string | null; created_at: string; actor_name: string | null }>;
  returns: Array<{ id: string; status: string; reason: string; restock: boolean; items: Array<{ order_item_id: string; quantity: number }>; created_at: string }>;
  allowed_transitions: Array<'preparing' | 'ready' | 'collected'>;
  can_cancel: boolean;
};

const STEP_ICON = { preparing: PackageOpen, ready: PackageCheck, collected: CircleCheck } as const;

export function OrderDrawer({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useApiQuery<Order>(['order', access.slug, orderId], access.api(`/orders/${orderId}`));
  const canManage = access.can('orders.manage') && !access.readOnly;
  const [confirm, setConfirm] = useState<'preparing' | 'ready' | 'collected' | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [returnOpen, setReturnOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try {
      await fn();
      toast({ tone: 'ok', text: t('commerce.orders.updated') });
      await q.refetch();
      qc.invalidateQueries({ queryKey: ['orders', access.slug] });
      return true;
    } catch (e) { setErr(e); return false; } finally { setBusy(false); }
  }

  const o = q.data;
  return (
    <Drawer open onClose={onClose} wide title={o ? <span dir="ltr">{o.number}</span> : t('commerce.orders.title')}
      footer={o && canManage && (o.allowed_transitions.length || o.can_cancel) ? (
        <div className="flex w-full flex-wrap justify-between gap-2">
          {o.can_cancel ? <Button variant="ghost" icon={<XCircle className="size-4" />} onClick={() => setCancelOpen(true)}>{t('commerce.orders.cancel')}</Button> : <span />}
          <div className="flex flex-wrap gap-2">
            {o.allowed_transitions.map((s, i) => {
              const Icon = STEP_ICON[s];
              return <Button key={s} variant={i === 0 ? 'primary' : 'outline'} icon={<Icon className="size-4" />} onClick={() => setConfirm(s)}>{t(`commerce.orders.to.${s}`)}</Button>;
            })}
          </div>
        </div>
      ) : undefined}>
      {q.isLoading ? <LoadingState rows={5} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : o ? (
        <div className="flex flex-col gap-5">
          <FormErrorSummary message={err ? msg(err) : null} />
          <div className="flex flex-wrap items-center gap-2">
            <OrderStatusBadge status={o.status} />
            <Badge tone={o.refund_status === 'none' ? 'neutral' : 'warn'}>{t(`commerce.orders.refund.${o.refund_status}`)}</Badge>
            <Badge>{t(`commerce.orders.fulfillment.${o.fulfillment_method}`)}</Badge>
            <span className="text-xs text-ink-muted">{when(o.created_at)}</span>
          </div>
          {o.status === 'pending_payment' && o.expires_at ? <Alert tone="warn">{t('commerce.orders.expires', { time: when(o.expires_at) })}</Alert> : null}

          <section>
            <h3 className="mb-1 text-sm font-semibold">{t('commerce.orders.customer')}</h3>
            <p>{o.customer_name}</p>
            <p className="text-sm text-ink-muted" dir="ltr">{[o.customer_phone, o.customer_email].filter(Boolean).join(' · ')}</p>
            {o.booking_number ? <p className="text-sm">{t('commerce.orders.booking', { number: o.booking_number })}</p> : null}
            {o.customer_note ? <p className="mt-1 rounded-lg bg-luma-50 p-2 text-sm"><span className="font-medium">{t('commerce.orders.note')}: </span>{o.customer_note}</p> : null}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('commerce.orders.lines')}</h3>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {o.items.map((i) => (
                <li key={i.id} className="flex items-start justify-between gap-3 p-3 text-sm">
                  <div>
                    <p className="font-medium">{pick(i.name_ar, i.name_en)}{i.variant_name_ar || i.variant_name_en ? ` — ${pick(i.variant_name_ar, i.variant_name_en)}` : ''}</p>
                    <p className="text-xs text-ink-muted" dir="ltr">{i.quantity} × {money(i.unit_price_minor)}{i.sku ? ` · ${i.sku}` : ''}</p>
                    {'unit_cost_minor' in i && i.unit_cost_minor != null ? <p className="text-xs text-ink-muted">{t('commerce.orders.unit_cost')}: {money(i.unit_cost_minor)}</p> : null}
                    {!i.returnable ? <Badge className="mt-1">{t('commerce.orders.not_returnable')}</Badge> : null}
                  </div>
                  <span dir="ltr" className="font-medium">{money(i.line_total_minor)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 flex flex-col gap-1 text-sm">
              <div className="flex justify-between"><dt>{t('commerce.orders.subtotal')}</dt><dd dir="ltr">{money(o.subtotal_minor)}</dd></div>
              {o.discount_minor ? <div className="flex justify-between text-ok"><dt>{t('commerce.orders.discount')}{o.coupon ? ` (${o.coupon.code})` : ''}</dt><dd dir="ltr">−{money(o.discount_minor)}</dd></div> : null}
              {o.tax_minor ? <div className="flex justify-between"><dt>{t('commerce.orders.tax')}</dt><dd dir="ltr">{money(o.tax_minor)}</dd></div> : null}
              <div className="flex justify-between border-t border-line pt-1 font-semibold"><dt>{t('commerce.orders.total')}</dt><dd dir="ltr">{money(o.total_minor)}</dd></div>
              <div className="flex justify-between text-ink-muted"><dt>{t('commerce.orders.paid')}</dt><dd dir="ltr">{money(o.paid_minor)}</dd></div>
              {o.refunded_minor ? <div className="flex justify-between text-ink-muted"><dt>{t('commerce.orders.refunded')}</dt><dd dir="ltr">{money(o.refunded_minor)}</dd></div> : null}
            </dl>
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold">{t('commerce.orders.payments')}</h3>
            <p className="mb-2 text-xs text-ink-muted">{t('commerce.orders.payments_note')}</p>
            {o.payments.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {o.payments.map((p) => <li key={p.id} className="flex justify-between"><span>{p.method} · <Badge>{p.status}</Badge></span><span dir="ltr">{money(p.amount_minor)}</span></li>)}
              </ul>
            ) : <p className="text-sm text-ink-muted">{t('commerce.orders.no_payments')}</p>}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t('commerce.orders.returns')}</h3>
              {canManage && o.status === 'collected' && o.items.some((i) => i.returnable) ? <Button size="sm" variant="outline" icon={<Undo2 className="size-4" />} onClick={() => setReturnOpen(true)}>{t('commerce.orders.new_return')}</Button> : null}
            </div>
            {o.returns.length ? (
              <ul className="flex flex-col gap-2">
                {o.returns.map((r) => (
                  <li key={r.id} className="rounded-lg border border-line p-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span><Badge tone={r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'danger' : 'warn'}>{t(`commerce.orders.return_status.${r.status}`)}</Badge> {r.reason}</span>
                      {canManage && r.status === 'requested' ? (
                        <span className="flex gap-1">
                          <Button size="sm" loading={busy} onClick={() => run(() => api(access.api(`/orders/${o.id}/returns/${r.id}`), { method: 'PATCH', body: { decision: 'approved' } }))}>{t('commerce.orders.approve')}</Button>
                          <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => api(access.api(`/orders/${o.id}/returns/${r.id}`), { method: 'PATCH', body: { decision: 'rejected' } }))}>{t('commerce.orders.reject')}</Button>
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-ink-muted">{r.items.map((ri) => { const it = o.items.find((x) => x.id === ri.order_item_id); return `${ri.quantity} × ${it ? pick(it.name_ar, it.name_en) : ''}`; }).join('، ')}{r.restock ? ` · ${t('commerce.orders.restock')}` : ''}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('commerce.orders.history')}</h3>
            <ol className="flex flex-col gap-2 border-s-2 border-luma-100 ps-4">
              {o.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <p className="font-medium">{t(`commerce.orders.event.${e.kind}`)}{e.to_status && e.kind === 'status_changed' ? `: ${t(`commerce.orders.status.${e.to_status}`)}` : ''}</p>
                  <p className="text-xs text-ink-muted">{when(e.created_at)} · {e.actor_name ? t('commerce.orders.by', { name: e.actor_name }) : t('commerce.orders.system')}</p>
                  {e.reason ? <p className="text-xs">{e.reason}</p> : null}
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} loading={busy}
        title={confirm ? t('commerce.orders.confirm_status', { label: t(`commerce.orders.to.${confirm}`) }) : ''}
        body={confirm === 'collected' ? t('commerce.orders.confirm_collected') : undefined}
        onConfirm={async () => { if (confirm && await run(() => api(access.api(`/orders/${orderId}/status`), { body: { to: confirm } }))) setConfirm(null); }} />
      <Dialog open={cancelOpen} onClose={() => setCancelOpen(false)} title={t('commerce.orders.cancel_title', { number: o?.number ?? '' })} footer={<>
        <Button variant="ghost" onClick={() => setCancelOpen(false)}>{t('actions.back')}</Button>
        <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={async () => { if (await run(() => api(access.api(`/orders/${orderId}/cancel`), { body: { reason: reason.trim() } }))) { setCancelOpen(false); setReason(''); } }}>{t('commerce.orders.cancel')}</Button>
      </>}>
        <p className="mb-3 text-ink-muted">{t('commerce.orders.cancel_body')}</p>
        <Field label={t('commerce.orders.cancel_reason')} required>{(p) => <Input {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Field>
      </Dialog>
      {returnOpen && o ? <ReturnDialog order={o} onClose={() => setReturnOpen(false)} onDone={() => { setReturnOpen(false); q.refetch(); toast({ tone: 'ok', text: t('commerce.orders.return_created') }); }} /> : null}
    </Drawer>
  );
}

function ReturnDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const items = Object.entries(qty).map(([id, v]) => ({ order_item_id: id, quantity: Math.trunc(Number(v) || 0) })).filter((i) => i.quantity > 0);
  return (
    <Dialog open onClose={onClose} title={t('commerce.orders.new_return')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button loading={busy} disabled={!items.length || reason.trim().length < 3} onClick={async () => {
        setBusy(true); setErr(null);
        try { await api(access.api(`/orders/${order.id}/returns`), { body: { reason: reason.trim(), restock, items } }); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>{t('actions.submit')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={err ? msg(err) : null} />
        {order.items.filter((i) => i.returnable).map((i) => (
          <Field key={i.id} label={`${pick(i.name_ar, i.name_en)} (≤ ${i.quantity})`}>{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={qty[i.id] ?? ''} onChange={(e) => setQty((x) => ({ ...x, [i.id]: e.target.value }))} />}</Field>
        ))}
        <Field label={t('commerce.orders.return_reason')} required>{(p) => <Input {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Checkbox label={t('commerce.orders.restock')} checked={restock} onChange={setRestock} />
      </div>
    </Dialog>
  );
}
