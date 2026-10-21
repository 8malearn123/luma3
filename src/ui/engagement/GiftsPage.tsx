'use client';

import { useState } from 'react';
import { AlertTriangle, Check, Copy, Gift, Plus, Search, TicketCheck } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useDebounced, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState, Spinner } from '../components/feedback';
import { Card, DataTable, PageHeader, Tabs, type Column } from '../components/layout';
import { ConfirmDialog, Dialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { StepUpProvider, useStepUp } from '../policy/StepUp';
import { ReasonDialog } from './shared';

type Card_ = { id: string; code_last4: string; initial_minor: number; balance_minor: number; status: string; template_key: string; recipient_name: string | null; expires_at: string | null; created_at: string };
type Issued = { id: string; code: string; last4: string; amount_minor: number };
const TEMPLATES = ['classic', 'floral', 'minimal', 'celebration'] as const;
const TONE: Record<string, 'ok' | 'neutral' | 'warn' | 'danger'> = { active: 'ok', redeemed: 'neutral', expired: 'neutral', void: 'danger', pending: 'warn' };

export function GiftsPage() {
  return <StepUpProvider><GiftsInner /></StepUpProvider>;
}

function GiftsInner() {
  const { t } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const toast = useToast();
  const stepUp = useStepUp();
  const [tab, setTab] = useState<'cards' | 'redeem'>('cards');
  const list = useApiQuery<Card_[]>(['gift-cards', access.slug], access.api('/gift-cards'));
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [voiding, setVoiding] = useState<Card_ | null>(null);
  const canManage = !access.readOnly;
  const canRedeem = access.can('payments.collect') && !access.readOnly;
  const outstanding = (list.data ?? []).filter((c) => c.status === 'active').reduce((a, c) => a + c.balance_minor, 0);

  const cols: Column<Card_>[] = [
    { key: 'code', header: t('fe.gifts.code'), cell: (c) => <span dir="ltr" className="font-mono">•••• {c.code_last4}</span> },
    { key: 'recipient', header: t('engagement.gifts.recipient'), className: 'hidden sm:table-cell', cell: (c) => c.recipient_name ?? '—' },
    { key: 'balance', header: t('engagement.gifts.balance'), cell: (c) => <span dir="ltr"><span className="font-medium">{money(c.balance_minor)}</span><span className="text-xs text-ink-muted"> / {money(c.initial_minor)}</span></span> },
    { key: 'expires', header: t('fe.gifts.expires'), className: 'hidden md:table-cell', cell: (c) => <span className="text-xs">{c.expires_at ? when(c.expires_at) : '—'}</span> },
    {
      key: 'status', header: t('fields.status'), cell: (c) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={TONE[c.status] ?? 'neutral'}>{t(`fe.gifts.status.${c.status}`)}</Badge>
          {canManage && c.status === 'active' ? <Button size="sm" variant="ghost" className="text-danger" onClick={() => setVoiding(c)}>{t('engagement.gifts.void')}</Button> : null}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title={t('engagement.gifts.title')} subtitle={t('fe.gifts.subtitle')} actions={canManage ? <Button icon={<Plus className="size-4" />} onClick={() => setIssuing(true)}>{t('engagement.gifts.issue')}</Button> : null} />
      {canRedeem ? <Tabs value={tab} onChange={setTab} items={[{ value: 'cards', label: t('fe.gifts.cards') }, { value: 'redeem', label: t('fe.gifts.redeem') }]} /> : null}
      {tab === 'redeem' && canRedeem ? <RedeemPanel onDone={() => list.refetch()} /> : (
        list.isLoading ? <LoadingState rows={4} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
          <EmptyState icon={<Gift className="size-8" aria-hidden />} title={t('fe.gifts.empty')} hint={canManage ? t('fe.gifts.empty_hint') : undefined} />
        ) : (
          <>
            <p className="mb-2 text-sm text-ink-muted">{t('fe.gifts.outstanding')}: <span dir="ltr" className="font-semibold text-ink">{money(outstanding)}</span></p>
            <DataTable rows={list.data} columns={cols} rowKey={(c) => c.id} caption={t('engagement.gifts.title')} />
            <p className="mt-2 text-xs text-ink-muted">{t('fe.gifts.hash_note')}</p>
          </>
        )
      )}
      {issuing ? <IssueDrawer onClose={() => setIssuing(false)} onIssued={(r) => { setIssuing(false); setIssued(r); list.refetch(); }} /> : null}
      {issued ? <CodeOnceDialog card={issued} onClose={() => setIssued(null)} /> : null}
      <ReasonDialog open={!!voiding} onClose={() => setVoiding(null)} title={t('fe.gifts.void_title')} confirmLabel={t('engagement.gifts.void')} maxLength={200}
        body={voiding ? t('fe.gifts.void_body', { last4: voiding.code_last4, amount: money(voiding.balance_minor) }) : null}
        onConfirm={async (reason) => {
          await stepUp(() => api(access.api(`/gift-cards/${voiding!.id}/void`), { body: { reason } }));
          setVoiding(null); await list.refetch(); toast({ tone: 'ok', text: t('fe.gifts.voided') });
        }} />
    </div>
  );
}

function IssueDrawer({ onClose, onIssued }: { onClose: () => void; onIssued: (r: Issued) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { money } = useFmt();
  const [f, setF] = useState({ amount: null as number | null, template: 'classic', recipient: '', contact: '', message: '', days: '365', method: 'cash' as 'cash' | 'pos_terminal' | 'complimentary', reference: '', reason: '' });
  const [confirm, setConfirm] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  useUnsavedChangesWarning(f.amount != null || !!f.recipient);
  const days = Number(f.days);
  const ok = (f.amount ?? 0) >= 1000 && (f.amount ?? 0) <= 10_000_000 && Number.isInteger(days) && days >= 30 && days <= 1095
    && (f.method === 'complimentary' ? f.reason.trim().length >= 3 : f.reference.trim().length >= 2);
  const issue = useApiMutation<void, Issued>((_v, { idempotencyKey }) => api(access.api('/gift-cards'), {
    idempotencyKey,
    body: {
      amount_minor: f.amount, template_key: f.template, recipient_name: f.recipient.trim() || undefined, recipient_contact: f.contact.trim() || undefined,
      message: f.message.trim() || undefined, expires_in_days: days,
      paid: f.method === 'complimentary' ? { method: 'complimentary', reason: f.reason.trim() } : { method: f.method, reference: f.reference.trim() },
    },
  }), { onSuccess: (r) => onIssued(r) });
  const issues = issue.error instanceof ApiError && issue.error.code === 'validation_failed' ? (issue.error.details?.issues as Array<{ path: string; message: string }>) : undefined;
  return (
    <Drawer open onClose={onClose} title={t('engagement.gifts.issue')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button disabled={!ok} loading={issue.isPending} onClick={() => setConfirm(true)}>{t('engagement.gifts.issue')}</Button>
    </>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={issue.error ? msg(issue.error) : null} issues={issues} />
        <Field label={t('engagement.gifts.amount')} required hint={t('fe.gifts.amount_hint')}>{(p) => <MoneyInput {...p} value={f.amount} onChange={(m) => set({ amount: m })} />}</Field>
        <Field label={t('engagement.gifts.template')}>{(p) => (
          <Select {...p} value={f.template} onChange={(e) => set({ template: e.target.value })}>
            {TEMPLATES.map((k) => <option key={k} value={k}>{t(`engagement.gifts.templates.${k}`)}</option>)}
          </Select>
        )}</Field>
        <Field label={t('engagement.gifts.recipient')} hint={t('fields.optional')}>{(p) => <Input {...p} maxLength={80} value={f.recipient} onChange={(e) => set({ recipient: e.target.value })} />}</Field>
        <Field label={t('fe.gifts.contact')} hint={t('fe.gifts.contact_hint')}>{(p) => <Input {...p} maxLength={120} dir="ltr" value={f.contact} onChange={(e) => set({ contact: e.target.value })} />}</Field>
        <Field label={t('engagement.gifts.message')} hint={t('fields.optional')}>{(p) => <Textarea {...p} maxLength={300} value={f.message} onChange={(e) => set({ message: e.target.value })} />}</Field>
        <Field label={t('fe.gifts.validity_days')}>{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={f.days} onChange={(e) => set({ days: e.target.value.replace(/[^0-9]/g, '') })} />}</Field>
        <Field label={t('engagement.gifts.paid_by')} required>{(p) => (
          <Select {...p} value={f.method} onChange={(e) => set({ method: e.target.value as typeof f.method })}>
            <option value="cash">{t('booking.dashboard.cash')}</option>
            <option value="pos_terminal">{t('booking.dashboard.pos')}</option>
            <option value="complimentary">{t('engagement.gifts.complimentary')}</option>
          </Select>
        )}</Field>
        {f.method === 'complimentary'
          ? <Field label={t('fields.reason')} required>{(p) => <Input {...p} maxLength={200} value={f.reason} onChange={(e) => set({ reason: e.target.value })} />}</Field>
          : <Field label={t('booking.dashboard.reference')} required>{(p) => <Input {...p} maxLength={80} dir="ltr" value={f.reference} onChange={(e) => set({ reference: e.target.value })} />}</Field>}
        <p className="text-xs text-ink-muted">{t('fe.gifts.collect_note')}</p>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={t('fe.gifts.confirm_title')}
        body={t(f.method === 'complimentary' ? 'fe.gifts.confirm_comp' : 'fe.gifts.confirm_body', { amount: money(f.amount ?? 0), method: f.method === 'cash' ? t('booking.dashboard.cash') : t('booking.dashboard.pos') })}
        onConfirm={() => { setConfirm(false); issue.mutate(); }} />
    </Drawer>
  );
}

/** The code exists only in this response: show it once, with copy, and make the warning unmissable. */
function CodeOnceDialog({ card, onClose }: { card: Issued; onClose: () => void }) {
  const { t } = useI18n();
  const { money } = useFmt();
  const [copied, setCopied] = useState(false);
  const [ack, setAck] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(card.code); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  }
  return (
    <Dialog open onClose={() => { if (ack) onClose(); }} title={t('fe.gifts.issued_title')} footer={<Button disabled={!ack} onClick={onClose}>{t('actions.done')}</Button>}>
      <div className="flex flex-col gap-3">
        <div role="alert" className="flex gap-2 rounded-lg border-2 border-warn/40 bg-warn-bg p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <p className="font-medium text-warn">{t('engagement.gifts.code_once')}</p>
        </div>
        <p className="text-ink-muted">{t('fe.gifts.issued_body', { amount: money(card.amount_minor) })}</p>
        <div className="flex items-center gap-2 rounded-xl border border-luma-300 bg-luma-50 p-3">
          <code dir="ltr" className="flex-1 select-all break-all text-center font-mono text-lg font-semibold tracking-wider text-luma-900" aria-label={t('fe.gifts.code')}>{card.code}</code>
          <Button size="sm" variant="outline" icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />} onClick={copy}>{copied ? t('actions.copied') : t('actions.copy')}</Button>
        </div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 accent-luma-700" checked={ack} onChange={(e) => setAck(e.target.checked)} />{t('fe.gifts.saved_ack')}</label>
      </div>
    </Dialog>
  );
}

type BookingRow = { id: string; number: string; status: string; starts_at: string; total_minor: number; paid_minor: number; customer_name: string };

function RedeemPanel({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const msg = useErrorMessage();
  const toast = useToast();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const canSearch = access.can('bookings.view_all', 'bookings.view_financial');
  const found = useApiQuery<BookingRow[]>(['gift-redeem-bookings', access.slug, term], canSearch && term.length >= 2 ? access.api(`/bookings?q=${encodeURIComponent(term)}&limit=8`) : null);
  const [booking, setBooking] = useState<BookingRow | null>(null);
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ redeemed_minor: number; remaining_minor: number } | null>(null);
  const due = booking ? Math.max(0, booking.total_minor - booking.paid_minor) : 0;
  const redeem = useApiMutation<void, { redeemed_minor: number; remaining_minor: number }>((_v, { idempotencyKey }) => api(access.api('/gift-cards/redeem'), {
    idempotencyKey, body: { code: code.trim(), booking_id: booking!.id, amount_minor: amount },
  }), { onSuccess: (r) => { setConfirm(false); setResult(r); setCode(''); setAmount(null); setBooking(null); onDone(); toast({ tone: 'ok', text: t('fe.gifts.redeemed') }); } });
  const ok = !!booking && code.trim().length >= 8 && (amount ?? 0) > 0;
  return (
    <Card title={t('fe.gifts.redeem_title')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">{t('fe.gifts.redeem_intro')}</p>
        {result ? <Alert tone="ok">{t('fe.gifts.redeem_result', { amount: money(result.redeemed_minor), remaining: money(result.remaining_minor) })}</Alert> : null}
        {!canSearch ? <Alert tone="info">{t('fe.gifts.no_booking_search')}</Alert> : booking ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-luma-300 bg-luma-50 px-3 py-2 text-sm">
            <span><span dir="ltr" className="font-mono font-medium">{booking.number}</span> · {booking.customer_name}<span className="block text-xs text-ink-muted">{when(booking.starts_at)} · {t('fe.gifts.due')}: <span dir="ltr">{money(due)}</span></span></span>
            <Button size="sm" variant="ghost" onClick={() => setBooking(null)}>{t('fe.common.change')}</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Field label={t('fe.gifts.booking')} hint={t('fe.gifts.booking_hint')}>{(p) => (
              <div className="relative">
                <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-muted" aria-hidden />
                <Input {...p} className="ps-9" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
              </div>
            )}</Field>
            {term.length >= 2 ? (found.isLoading ? <Spinner /> : found.error ? <ErrorState error={found.error} /> : !found.data?.length ? <p className="text-xs text-ink-muted">{t('fe.gifts.no_bookings')}</p> : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {found.data.map((b) => (
                  <li key={b.id}>
                    <button type="button" disabled={['cancelled', 'expired'].includes(b.status)} onClick={() => { setBooking(b); setAmount(Math.max(0, b.total_minor - b.paid_minor)); setQ(''); }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-luma-50 disabled:opacity-50">
                      <span><span dir="ltr" className="font-mono">{b.number}</span> · {b.customer_name}<span className="block text-xs text-ink-muted">{when(b.starts_at)} · {t(`booking.status.${b.status}`)}</span></span>
                      <span dir="ltr" className="text-xs">{money(Math.max(0, b.total_minor - b.paid_minor))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )) : null}
          </div>
        )}
        <Field label={t('fe.gifts.code')} required>{(p) => <Input {...p} dir="ltr" autoComplete="off" className="font-mono uppercase" maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
        <Field label={t('fe.gifts.redeem_amount')} required hint={booking ? t('fe.gifts.redeem_amount_hint', { amount: money(due) }) : undefined}>{(p) => <MoneyInput {...p} key={booking?.id ?? 'none'} value={amount} onChange={setAmount} />}</Field>
        <div className="flex justify-end"><Button icon={<TicketCheck className="size-4" />} disabled={!ok} loading={redeem.isPending} onClick={() => setConfirm(true)}>{t('fe.gifts.redeem')}</Button></div>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} loading={redeem.isPending} title={t('fe.gifts.redeem_confirm_title')}
        body={<>{booking ? t('fe.gifts.redeem_confirm_body', { amount: money(amount ?? 0), number: booking.number }) : null}{redeem.error ? <p className="mt-2 text-danger">{msg(redeem.error)}</p> : null}</>}
        onConfirm={() => redeem.mutate()} />
    </Card>
  );
}
