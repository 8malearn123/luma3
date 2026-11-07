'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CalendarClock, MapPin, PartyPopper, Settings2, UsersRound } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select, Switch, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { PageHeader, Tabs } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { ReasonDialog, useMountTime } from '../engagement/shared';
import { depositFromPercent } from '@/shared/schemas/events';

type Row = {
  id: string; number: string; status: string; occasion: string; starts_at: string; ends_at: string | null; location_type: string; location_text: string | null; people_count: number;
  total_minor: number | null; deposit_minor: number | null; paid_minor: number; refunded_minor: number; customer_name: string; staff_name: string | null; created_at: string;
};
type Detail = Row & {
  notes: string | null; contact_phone: string | null; staff_id: string | null; duration_min: number | null; prep_before_min: number; prep_after_min: number; subtotal_minor: number | null; tax_minor: number | null;
  quote_note: string | null; quote_expires_at: string | null; quote_version: number; balance_due_minor: number | null; cancel_reason: string | null; decline_reason: string | null; cancel_source: string | null;
  customer: { display_name: string; phone: string | null; email: string | null };
  services: Array<{ id: string; name_ar: string | null; name_en: string | null; price_minor: number; duration_min: number }>;
  payments: Array<{ id: string; kind: string; method: string; status: string; amount_minor: number; captured_at: string | null }>;
  refunds: Array<{ id: string; amount_minor: number; status: string; reason: string }>;
};
type Settings = { enabled: boolean; default_deposit_bp: number; free_cancellation_days: number; quote_validity_days: number; max_people: number; intro_ar: string | null; intro_en: string | null };
type Staff = { id: string; display_name: string; is_active: boolean; archived_at: string | null };

const TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand'> = {
  requested: 'warn', quoted: 'info', pending_payment: 'warn', confirmed: 'ok', completed: 'brand', declined: 'neutral', expired: 'neutral', cancelled: 'danger',
};
const VIEWS = { requests: ['requested'], quotes: ['quoted', 'pending_payment'], upcoming: ['confirmed'], closed: ['completed', 'declined', 'expired', 'cancelled'] } as const;
type View = keyof typeof VIEWS;

/** Event bookings («حجوزات المناسبات»): requests → quotes → confirmed events with a deposit. */
export function EventsPage() {
  const { t } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const router = useRouter();
  const params = useSearchParams();
  const [view, setView] = useState<View>('requests');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const list = useApiQuery<Row[]>(['events', access.slug], access.api('/events'));
  const openId = params.get('id');
  const open = (id: string | null) => router.replace(id ? `?id=${id}` : '?', { scroll: false });
  const rows = (list.data ?? []).filter((r) => (VIEWS[view] as readonly string[]).includes(r.status));
  const count = (v: View) => (list.data ?? []).filter((r) => (VIEWS[v] as readonly string[]).includes(r.status)).length;

  return (
    <div>
      <PageHeader title={t('expert.events.title')} subtitle={t('expert.events.subtitle')}
        actions={access.can('business.manage') ? <Button variant="outline" icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen(true)}>{t('expert.events.settings')}</Button> : null} />
      <Tabs value={view} onChange={setView} items={(Object.keys(VIEWS) as View[]).map((v) => ({ value: v, label: t(`expert.events.views.${v}`), count: count(v) }))} />
      {list.isLoading ? <LoadingState rows={4} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? (
        <EmptyState icon={<PartyPopper className="size-8" aria-hidden />} title={t(`expert.events.empty.${view}`)} hint={view === 'requests' ? t('expert.events.empty_hint') : undefined} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => open(r.id)} className="flex w-full flex-col gap-1 rounded-2xl border border-line bg-white p-4 text-start hover:border-luma-300 focus-visible:outline-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-luma-900">{t(`expert.occasions.${r.occasion}`)} · <bdi>{r.customer_name}</bdi></p>
                  <Badge tone={TONE[r.status] ?? 'neutral'}>{t(`expert.events.status.${r.status}`)}</Badge>
                </div>
                <p className="flex items-center gap-1 text-sm"><CalendarClock className="size-4 text-ink-muted" aria-hidden />{when(r.starts_at)}</p>
                <p className="flex items-center gap-3 text-xs text-ink-muted">
                  <span className="inline-flex items-center gap-1"><UsersRound className="size-3.5" aria-hidden />{t('expert.events.people', { n: r.people_count })}</span>
                  <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" aria-hidden />{t(`expert.events.location.${r.location_type}`)}</span>
                  <span dir="ltr" className="ms-auto">{r.number}</span>
                </p>
                {r.total_minor != null ? <p className="text-sm">{t('expert.events.total')}: <span dir="ltr" className="font-medium">{money(r.total_minor)}</span> · {t('expert.events.deposit')}: <span dir="ltr">{money(r.deposit_minor)}</span></p> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {openId ? <EventDrawer id={openId} onClose={() => open(null)} onChanged={() => list.refetch()} /> : null}
      {settingsOpen ? <SettingsDrawer onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}

function EventDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const toast = useToast();
  const q = useApiQuery<Detail>(['event', access.slug, id], access.api(`/events/${id}`));
  const [mode, setMode] = useState<'view' | 'quote' | 'balance'>('view');
  const [reason, setReason] = useState<'decline' | 'cancel' | null>(null);
  const manage = access.can('bookings.manage') && !access.readOnly;
  const refresh = async () => { await q.refetch(); onChanged(); };
  const complete = useApiMutation<void, unknown>(() => api(access.api(`/events/${id}/complete`), { body: {} }), { onSuccess: async () => { await refresh(); toast({ tone: 'ok', text: t('expert.events.completed_ok') }); } });
  const msg = useErrorMessage();
  const now = useMountTime();
  const e = q.data;

  return (
    <Drawer open wide onClose={onClose} title={e ? `${t(`expert.occasions.${e.occasion}`)} · ${e.number}` : t('states.loading')}>
      {q.isLoading ? <LoadingState rows={4} /> : q.error ? <ErrorState error={q.error} /> : e ? (
        mode === 'quote' ? <QuoteForm e={e} onCancel={() => setMode('view')} onSaved={async () => { setMode('view'); await refresh(); toast({ tone: 'ok', text: t('expert.events.quote_sent') }); }} />
          : mode === 'balance' ? <BalanceForm e={e} onCancel={() => setMode('view')} onSaved={async () => { setMode('view'); await refresh(); toast({ tone: 'ok', text: t('expert.events.balance_ok') }); }} />
            : (
              <div className="flex flex-col gap-4 text-sm">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={TONE[e.status] ?? 'neutral'}>{t(`expert.events.status.${e.status}`)}</Badge>
                  {e.status === 'quoted' && e.quote_expires_at ? <span className="text-xs text-ink-muted">{t('expert.events.quote_valid_until', { when: when(e.quote_expires_at) })}</span> : null}</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                  <dt className="text-ink-muted">{t('expert.events.when')}</dt><dd>{when(e.starts_at)}{e.ends_at ? ` → ${when(e.ends_at)}` : ''}</dd>
                  <dt className="text-ink-muted">{t('expert.events.where')}</dt><dd>{t(`expert.events.location.${e.location_type}`)}{e.location_text ? ` — ${e.location_text}` : ''}</dd>
                  <dt className="text-ink-muted">{t('expert.events.people_label')}</dt><dd>{e.people_count}</dd>
                  <dt className="text-ink-muted">{t('expert.events.customer')}</dt><dd><bdi>{e.customer.display_name}</bdi>{e.contact_phone || e.customer.phone ? <> · <a dir="ltr" className="text-luma-700 underline" href={`tel:${e.contact_phone ?? e.customer.phone}`}>{e.contact_phone ?? e.customer.phone}</a></> : null}</dd>
                  {e.services.length ? <><dt className="text-ink-muted">{t('expert.events.services')}</dt><dd>{e.services.map((s) => pick(s.name_ar, s.name_en)).join('، ')}</dd></> : null}
                  {e.staff_name ? <><dt className="text-ink-muted">{t('expert.events.specialist')}</dt><dd>{e.staff_name}</dd></> : null}
                </dl>
                {e.notes ? <p className="whitespace-pre-line rounded-lg bg-luma-50 p-3">{e.notes}</p> : null}
                {e.total_minor != null ? (
                  <div className="rounded-xl border border-line p-3">
                    <div className="flex justify-between"><span>{t('expert.events.total')}</span><span dir="ltr" className="font-semibold">{money(e.total_minor)}</span></div>
                    {e.tax_minor ? <div className="flex justify-between text-xs text-ink-muted"><span>{t('expert.events.tax_included')}</span><span dir="ltr">{money(e.tax_minor)}</span></div> : null}
                    <div className="flex justify-between"><span>{t('expert.events.deposit')}</span><span dir="ltr">{money(e.deposit_minor)}</span></div>
                    <div className="flex justify-between"><span>{t('expert.events.paid')}</span><span dir="ltr">{money(e.paid_minor)}</span></div>
                    {e.refunded_minor ? <div className="flex justify-between"><span>{t('expert.events.refunded')}</span><span dir="ltr">{money(e.refunded_minor)}</span></div> : null}
                    {['confirmed', 'completed'].includes(e.status) ? <div className="flex justify-between font-medium"><span>{t('expert.events.balance_due')}</span><span dir="ltr">{money(e.balance_due_minor)}</span></div> : null}
                  </div>
                ) : null}
                {e.decline_reason ? <Alert tone="info">{t('expert.events.declined_because', { reason: e.decline_reason })}</Alert> : null}
                {e.cancel_reason ? <Alert tone="warn">{t(`expert.events.cancelled_by.${e.cancel_source ?? 'business'}`)}: {e.cancel_reason}</Alert> : null}
                {e.payments.length ? (
                  <div><p className="mb-1 font-medium">{t('expert.events.payments')}</p>
                    <ul className="flex flex-col gap-1">{e.payments.map((p) => <li key={p.id} className="flex justify-between rounded-md bg-luma-50 px-2 py-1"><span>{t(`expert.events.pay_kind.${p.kind}`)} · {t(`expert.events.pay_status.${p.status}`)}</span><span dir="ltr">{money(p.amount_minor)}</span></li>)}</ul>
                  </div>
                ) : null}
                {complete.error ? <p role="alert" className="text-danger">{msg(complete.error)}</p> : null}
                {manage ? (
                  <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                    {['requested', 'quoted', 'expired'].includes(e.status) ? <Button onClick={() => setMode('quote')}>{e.status === 'requested' ? t('expert.events.send_quote') : t('expert.events.revise_quote')}</Button> : null}
                    {['requested', 'quoted', 'expired'].includes(e.status) ? <Button variant="ghost" onClick={() => setReason('decline')}>{t('expert.events.decline')}</Button> : null}
                    {e.status === 'confirmed' && access.can('payments.collect') && (e.balance_due_minor ?? 0) > 0 ? <Button variant="outline" onClick={() => setMode('balance')}>{t('expert.events.collect_balance')}</Button> : null}
                    {e.status === 'confirmed' && Date.parse(e.starts_at) <= now ? <Button variant="outline" loading={complete.isPending} onClick={() => complete.mutate()}>{t('expert.events.complete')}</Button> : null}
                    {['quoted', 'pending_payment', 'confirmed'].includes(e.status) ? <Button variant="ghost" className="text-danger" onClick={() => setReason('cancel')}>{t('expert.events.cancel')}</Button> : null}
                  </div>
                ) : null}
              </div>
            )
      ) : null}
      <ReasonDialog open={!!reason} onClose={() => setReason(null)} title={reason === 'decline' ? t('expert.events.decline') : t('expert.events.cancel')}
        body={reason === 'cancel' && e?.paid_minor ? t('expert.events.cancel_refund_note', { amount: money(e.paid_minor - e.refunded_minor) }) : null}
        confirmLabel={reason === 'decline' ? t('expert.events.decline') : t('expert.events.cancel')}
        onConfirm={async (text) => {
          await api(access.api(`/events/${id}/${reason}`), { body: { reason: text } });
          setReason(null); await refresh();
        }} />
    </Drawer>
  );
}

function QuoteForm({ e, onCancel, onSaved }: { e: Detail; onCancel: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { money } = useFmt();
  const settings = useApiQuery<Settings>(['event-settings', access.slug], access.api('/event-settings'));
  const staff = useApiQuery<Staff[] | { items: Staff[] }>(['fe-staff', access.slug], access.api('/staff'));
  const staffList = (Array.isArray(staff.data) ? staff.data : staff.data?.items ?? []).filter((s) => s.is_active && !s.archived_at);
  const suggested = e.services.reduce((a, s) => a + s.price_minor, 0) * Math.max(1, e.people_count);
  const [f, setF] = useState({
    price: (e.subtotal_minor ?? (suggested || null)) as number | null, hours: String((e.duration_min ?? 180) / 60), prep: String(e.prep_before_min ?? 0),
    depositMode: 'percent' as 'percent' | 'fixed', pct: '', fixed: null as number | null, days: '', note: e.quote_note ?? '', staff: e.staff_id ?? access.staffProfileId ?? '',
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const pct = Number(f.pct || (settings.data ? settings.data.default_deposit_bp / 100 : 30));
  const minutes = Math.round(Number(f.hours) * 60);
  const depositPreview = f.price ? (f.depositMode === 'percent' ? depositFromPercent(f.price, Math.round(pct * 100)) : Math.min(f.price, f.fixed ?? 0)) : 0;
  const ok = !!f.price && f.price >= 100 && minutes >= 15 && minutes <= 1440 && (f.depositMode === 'percent' ? pct >= 1 && pct <= 100 : (f.fixed ?? 0) >= 100);
  const save = useApiMutation<void, unknown>(() => api(access.api(`/events/${e.id}/quote`), {
    body: {
      price_minor: f.price, duration_min: minutes, prep_before_min: Math.max(0, Math.round(Number(f.prep) || 0)),
      deposit: f.depositMode === 'percent' ? { mode: 'percent', percent_bp: Math.round(pct * 100) } : { mode: 'fixed', amount_minor: f.fixed },
      ...(f.days ? { valid_days: Number(f.days) } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}), ...(f.staff ? { staff_id: f.staff } : {}),
    },
  }), { onSuccess: onSaved });
  const issues = save.error instanceof ApiError && save.error.code === 'validation_failed' ? (save.error.details?.issues as Array<{ path: string; message: string }>) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <FormErrorSummary message={save.error ? (save.error instanceof ApiError && save.error.code === 'slot_unavailable' ? t('expert.events.busy') : msg(save.error)) : null} issues={issues} />
      {staffList.length > 1 ? (
        <Field label={t('expert.events.specialist')}>{(p) => (
          <Select {...p} value={f.staff} onChange={(x) => set({ staff: x.target.value })}>
            {staffList.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
          </Select>
        )}</Field>
      ) : null}
      <Field label={t('expert.events.price')} hint={suggested ? t('expert.events.price_hint', { amount: money(suggested) }) : undefined} required>{(p) => <MoneyInput {...p} value={f.price} onChange={(v) => set({ price: v })} />}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('expert.events.duration_hours')} required>{(p) => <Input {...p} type="number" min={0.25} max={24} step={0.25} value={f.hours} onChange={(x) => set({ hours: x.target.value })} />}</Field>
        <Field label={t('expert.events.prep_min')} hint={t('expert.events.prep_hint')}>{(p) => <Input {...p} type="number" min={0} max={600} step={15} value={f.prep} onChange={(x) => set({ prep: x.target.value })} />}</Field>
      </div>
      <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <legend className="px-1 text-sm font-medium">{t('expert.events.deposit')}</legend>
        <div className="flex gap-2">
          <Button size="sm" variant={f.depositMode === 'percent' ? 'primary' : 'outline'} aria-pressed={f.depositMode === 'percent'} onClick={() => set({ depositMode: 'percent' })}>{t('expert.events.deposit_percent')}</Button>
          <Button size="sm" variant={f.depositMode === 'fixed' ? 'primary' : 'outline'} aria-pressed={f.depositMode === 'fixed'} onClick={() => set({ depositMode: 'fixed' })}>{t('expert.events.deposit_fixed')}</Button>
        </div>
        {f.depositMode === 'percent'
          ? <Field label={t('expert.events.deposit_percent')}>{(p) => <Input {...p} type="number" min={1} max={100} value={f.pct || String(pct)} onChange={(x) => set({ pct: x.target.value })} />}</Field>
          : <Field label={t('expert.events.deposit_fixed')}>{(p) => <MoneyInput {...p} value={f.fixed} onChange={(v) => set({ fixed: v })} />}</Field>}
        <p className="text-xs text-ink-muted">{t('expert.events.deposit_preview', { amount: money(depositPreview) })}</p>
      </fieldset>
      <Field label={t('expert.events.valid_days')}>{(p) => <Input {...p} type="number" min={1} max={30} value={f.days || String(settings.data?.quote_validity_days ?? 3)} onChange={(x) => set({ days: x.target.value })} />}</Field>
      <Field label={t('expert.events.quote_note')}>{(p) => <Textarea {...p} maxLength={1000} value={f.note} onChange={(x) => set({ note: x.target.value })} />}</Field>
      <p className="text-xs text-ink-muted">{t('expert.events.quote_explainer')}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{t('actions.cancel')}</Button>
        <Button disabled={!ok} loading={save.isPending} onClick={() => save.mutate()}>{t('expert.events.send_quote')}</Button>
      </div>
    </div>
  );
}

function BalanceForm({ e, onCancel, onSaved }: { e: Detail; onCancel: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [amount, setAmount] = useState<number | null>(e.balance_due_minor);
  const [method, setMethod] = useState<'cash' | 'pos_terminal'>('cash');
  const [ref, setRef] = useState('');
  const save = useApiMutation<void, unknown>((_v, { idempotencyKey }) => api(access.api(`/events/${e.id}/balance`), { body: { amount_minor: amount, method, reference: ref.trim() }, idempotencyKey }), { onSuccess: onSaved });
  return (
    <div className="flex flex-col gap-4">
      <FormErrorSummary message={save.error ? msg(save.error) : null} />
      <Field label={t('expert.events.amount')} required>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
      <Field label={t('expert.events.method')}>{(p) => (
        <Select {...p} value={method} onChange={(x) => setMethod(x.target.value as 'cash' | 'pos_terminal')}>
          <option value="cash">{t('expert.events.methods.cash')}</option><option value="pos_terminal">{t('expert.events.methods.pos_terminal')}</option>
        </Select>
      )}</Field>
      <Field label={t('expert.events.reference')} required>{(p) => <Input {...p} maxLength={100} value={ref} onChange={(x) => setRef(x.target.value)} />}</Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{t('actions.cancel')}</Button>
        <Button disabled={!amount || !ref.trim()} loading={save.isPending} onClick={() => save.mutate()}>{t('actions.save')}</Button>
      </div>
    </div>
  );
}

function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const q = useApiQuery<Settings>(['event-settings', access.slug], access.api('/event-settings'));
  const [f, setF] = useState<Settings | null>(null);
  const s = f ?? q.data;
  const set = (p: Partial<Settings>) => setF({ ...(s as Settings), ...p });
  const save = useApiMutation<void, unknown>(() => api(access.api('/event-settings'), { method: 'PUT', body: s }), { invalidate: [['event-settings', access.slug]], onSuccess: () => { toast({ tone: 'ok', text: t('expert.events.settings_saved') }); onClose(); } });
  return (
    <Drawer open onClose={onClose} title={t('expert.events.settings')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button disabled={!s} loading={save.isPending} onClick={() => save.mutate()}>{t('actions.save')}</Button>
    </>}>
      {q.isLoading || !s ? <LoadingState rows={3} /> : (
        <div className="flex flex-col gap-4">
          <FormErrorSummary message={save.error ? msg(save.error) : null} />
          <Switch label={t('expert.events.s.enabled')} checked={s.enabled} onChange={(v) => set({ enabled: v })} />
          <Field label={t('expert.events.s.default_deposit')}>{(p) => <Input {...p} type="number" min={0} max={100} value={s.default_deposit_bp / 100} onChange={(x) => set({ default_deposit_bp: Math.round(Number(x.target.value) * 100) })} />}</Field>
          <Field label={t('expert.events.s.free_cancellation_days')} hint={t('expert.events.s.free_cancellation_hint')}>{(p) => <Input {...p} type="number" min={0} max={365} value={s.free_cancellation_days} onChange={(x) => set({ free_cancellation_days: Number(x.target.value) })} />}</Field>
          <Field label={t('expert.events.s.quote_validity_days')}>{(p) => <Input {...p} type="number" min={1} max={30} value={s.quote_validity_days} onChange={(x) => set({ quote_validity_days: Number(x.target.value) })} />}</Field>
          <Field label={t('expert.events.s.max_people')}>{(p) => <Input {...p} type="number" min={1} max={500} value={s.max_people} onChange={(x) => set({ max_people: Number(x.target.value) })} />}</Field>
          <Field label={t('expert.events.s.intro_ar')}>{(p) => <Textarea {...p} maxLength={1000} value={s.intro_ar ?? ''} onChange={(x) => set({ intro_ar: x.target.value || null })} />}</Field>
          <Field label={t('expert.events.s.intro_en')}>{(p) => <Textarea {...p} dir="ltr" maxLength={1000} value={s.intro_en ?? ''} onChange={(x) => set({ intro_en: x.target.value || null })} />}</Field>
        </div>
      )}
    </Drawer>
  );
}
