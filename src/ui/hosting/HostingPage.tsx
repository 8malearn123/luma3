'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Armchair, CalendarClock, Plus, ScanLine, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Checkbox, Field, FormErrorSummary, Input, MoneyInput, Select, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, PageHeader, Stat, Tabs } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { ReasonDialog } from '../engagement/shared';
import { StatementTable, TONE, type Statement } from './shared';

type Row = { id: string; number: string; status: string; starts_at: string; ends_at: string; total_minor: number; guest_name: string | null; space_code: string; hold_expires_at: string | null; settlement_status: string };
type Detail = Row & {
  check_in_code: string; booking_mode: string; approval_deadline: string | null; payment_status: string;
  guest: { name: string | null; provider_name: string | null }; statement: Statement;
  material_requests: Array<{ id: string; addon_id: string; quantity: number; note: string | null; status: string }>;
  settlements: Array<{ id: string; version: number; approved_at: string }>;
};
type Listing = { id: string; code: string; title_ar: string | null; title_en: string | null; status: string; price_model: string; price_minor: number; booking_mode: string; version: number; resource_name: string; branch_name: string };

const TABS = ['requests', 'bookings', 'spaces', 'chairs', 'money'] as const;
/** The server records a late-fee line as «Late check-out: N min (grace G min)»; shown in the reader's language. */
const lateFeeDetail = (d: string) => {
  const m = /(\d+) min \(grace (\d+) min\)/.exec(d);
  return m ? { over: m[1]!, grace: m[2]! } : null;
};
type Tab = (typeof TABS)[number];

/** «المساحات والاستضافة»: requests, bookings, spaces for rent, chair links, revenue & settlements. */
export function HostingPage() {
  const { t } = useI18n();
  const access = useAccess();
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>('requests');
  const list = useApiQuery<Row[]>(['hosting-bookings', access.slug], access.api('/hosting/bookings'));
  const openId = params.get('booking');
  const open = (id: string | null) => router.replace(id ? `?booking=${id}` : '?', { scroll: false });
  const requests = (list.data ?? []).filter((r) => r.status === 'pending_approval');
  const others = (list.data ?? []).filter((r) => r.status !== 'pending_approval');
  return (
    <div>
      <PageHeader title={t('hosting.title')} subtitle={t('hosting.subtitle')} />
      {access.can('hosting.manage', 'bookings.manage') ? <ScanBox onDone={(id) => { list.refetch(); open(id); }} /> : null}
      <Tabs value={tab} onChange={setTab} items={TABS.map((v) => ({ value: v, label: t(`hosting.tabs.${v}`), count: v === 'requests' ? requests.length : undefined }))} />
      {tab === 'requests' || tab === 'bookings' ? (
        list.isLoading ? <LoadingState rows={4} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : (
          <BookingList rows={tab === 'requests' ? requests : others} empty={t(`hosting.empty.${tab}`)} onOpen={open} />
        )
      ) : tab === 'spaces' ? <Spaces /> : tab === 'chairs' ? <ChairLinks /> : <Money />}
      {openId ? <BookingDrawer id={openId} onClose={() => open(null)} onChanged={() => list.refetch()} /> : null}
    </div>
  );
}

function BookingList({ rows, empty, onOpen }: { rows: Row[]; empty: string; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const { money, when } = useFmt();
  if (!rows.length) return <EmptyState icon={<Armchair className="size-8" aria-hidden />} title={empty} />;
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {rows.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onOpen(r.id)} className="flex w-full flex-col gap-1 rounded-2xl border border-line bg-white p-4 text-start hover:border-luma-300 focus-visible:outline-2">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-luma-900"><bdi>{r.guest_name}</bdi> · {r.space_code}</p>
              <Badge tone={TONE[r.status] ?? 'neutral'}>{t(`hosting.status.${r.status}`)}</Badge>
            </div>
            <p className="flex items-center gap-1 text-sm"><CalendarClock className="size-4 text-ink-muted" aria-hidden />{when(r.starts_at)} → {when(r.ends_at)}</p>
            <p className="text-sm">{t('hosting.total')}: <span dir="ltr">{money(r.total_minor)}</span> <span dir="ltr" className="ms-2 text-xs text-ink-muted">{r.number}</span></p>
            {r.status === 'pending_approval' && r.hold_expires_at ? <p className="text-xs text-amber-700">{t('hosting.respond_by', { when: when(r.hold_expires_at) })}</p> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ScanBox({ onDone }: { onDone: (id: string) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const [token, setToken] = useState('');
  const scan = useApiMutation<void, { id: string }>(() => api(access.api('/hosting/scan'), { body: { token: token.trim() } }), {
    onSuccess: (r) => { setToken(''); toast({ tone: 'ok', text: t('hosting.done') }); onDone(r.id); },
  });
  return (
    <Card className="mb-4" title={<span className="inline-flex items-center gap-2"><ScanLine className="size-4" aria-hidden />{t('hosting.scan_title')}</span>}>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (token.trim()) scan.mutate(); }}>
        <Field label={t('hosting.scan_hint')} className="min-w-64 flex-1">{(p) => <Input {...p} dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />}</Field>
        <Button type="submit" loading={scan.isPending} disabled={!token.trim()}>{t('hosting.scan')}</Button>
      </form>
      {scan.error ? <p role="alert" className="mt-2 text-sm text-red-700">{msg(scan.error)}</p> : null}
    </Card>
  );
}

function BookingDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const q = useApiQuery<Detail>(['hosting-booking', access.slug, id], access.api(`/hosting/bookings/${id}`));
  const [dialog, setDialog] = useState<'reject' | 'cancel' | null>(null);
  const [corr, setCorr] = useState<{ amount: number | null; desc: string }>({ amount: null, desc: '' });
  const manage = access.can('hosting.manage') && !access.readOnly;
  const done = async () => { await q.refetch(); onChanged(); toast({ tone: 'ok', text: t('hosting.done') }); };
  const act = useApiMutation<{ path: string; body?: unknown }, unknown>((v) => api(access.api(`/hosting/bookings/${id}${v.path}`), { body: v.body ?? {} }), { onSuccess: done });
  const b = q.data;
  return (
    <Drawer open wide onClose={onClose} title={b ? `${b.number} · ${b.guest.name ?? ''}` : t('states.loading')}>
      {q.isLoading ? <LoadingState rows={4} /> : q.error ? <ErrorState error={q.error} /> : b ? (
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={TONE[b.status] ?? 'neutral'}>{t(`hosting.status.${b.status}`)}</Badge>
            {b.status === 'pending_approval' && b.approval_deadline ? <span className="text-xs text-amber-700">{t('hosting.respond_by', { when: when(b.approval_deadline) })}</span> : null}</div>
          <Alert tone="info"><span className="inline-flex items-center gap-1"><ShieldCheck className="size-4" aria-hidden />{t('hosting.privacy_note')}</span></Alert>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-ink-muted">{t('hosting.guest')}</dt><dd><bdi>{b.guest.name}</bdi>{b.guest.provider_name ? ` — ${b.guest.provider_name}` : ''}</dd>
            <dt className="text-ink-muted">{t('hosting.when')}</dt><dd>{when(b.starts_at)} → {when(b.ends_at)}</dd>
          </dl>
          {['confirmed', 'checked_in', 'in_use'].includes(b.status) ? <p className="rounded-xl bg-luma-50 p-3 font-medium" dir="auto">{t('hosting.code_for_guest', { code: b.check_in_code })}</p> : null}
          {act.error ? <FormErrorSummary message={msg(act.error)} /> : null}
          {manage ? (
            <div className="flex flex-wrap gap-2">
              {b.status === 'pending_approval' ? <><Button loading={act.isPending} onClick={() => act.mutate({ path: '/decision', body: { approve: true } })}>{t('hosting.approve')}</Button>
                <Button variant="outline" onClick={() => setDialog('reject')}>{t('hosting.reject')}</Button></> : null}
              {b.status === 'confirmed' ? <Button onClick={() => act.mutate({ path: '/check', body: { action: 'in' } })}>{t('hosting.check_in')}</Button> : null}
              {['checked_in', 'in_use'].includes(b.status) ? <Button onClick={() => act.mutate({ path: '/check', body: { action: 'out' } })}>{t('hosting.check_out')}</Button> : null}
              {b.status === 'confirmed' ? <Button variant="outline" onClick={() => act.mutate({ path: '/no-show' })}>{t('hosting.no_show')}</Button> : null}
              {['held', 'pending_payment', 'confirmed'].includes(b.status) ? <Button variant="outline" onClick={() => setDialog('cancel')}>{t('hosting.cancel')}</Button> : null}
            </div>
          ) : null}
          {manage ? b.statement.lines.filter((l) => l.kind === 'late_fee' && l.status === 'proposed').map((l) => (
            <Card key={l.id} title={t('hosting.late_fee')}>
              <p className="mb-2">{lateFeeDetail(l.description) ? t('hosting.late_fee_detail', lateFeeDetail(l.description)!) : t('hosting.late_fee')} · <span dir="ltr">{money(l.amount_minor)}</span></p>
              <div className="flex gap-2"><Button size="sm" onClick={() => act.mutate({ path: `/late-fees/${l.id}`, body: { approve: true } })}>{t('hosting.approve_fee')}</Button>
                <Button size="sm" variant="outline" onClick={() => act.mutate({ path: `/late-fees/${l.id}`, body: { approve: false } })}>{t('hosting.reject_fee')}</Button></div>
            </Card>
          )) : null}
          {b.material_requests.length ? (
            <Card title={t('hosting.materials')}>
              <ul className="flex flex-col gap-2">{b.material_requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>×{r.quantity} {r.note ? `— ${r.note}` : ''} <Badge tone={TONE[r.status] ?? 'neutral'}>{t(`hosting.status.${r.status}`)}</Badge></span>
                  {manage && r.status === 'requested' ? <span className="flex gap-2">
                    <Button size="sm" onClick={() => act.mutate({ path: `/materials/${r.id}`, body: { approve: true } })}>{t('hosting.approve_material')}</Button>
                    <Button size="sm" variant="outline" onClick={() => act.mutate({ path: `/materials/${r.id}`, body: { approve: false } })}>{t('hosting.reject_material')}</Button></span> : null}
                </li>))}</ul>
            </Card>
          ) : null}
          <Card title={t('hosting.settlement')}>
            <StatementTable s={b.statement} />
            {manage && ['completed', 'cancelled', 'no_show', 'expired'].includes(b.status) && !['approved', 'settled'].includes(b.settlement_status) ? (
              <Button className="mt-3" onClick={() => act.mutate({ path: '/settlement' })}>{t('hosting.approve_settlement')}</Button>
            ) : null}
            {manage && ['completed', 'cancelled', 'no_show'].includes(b.status) ? (
              <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (corr.amount && corr.desc.trim()) act.mutate({ path: '/corrections', body: { amount_minor: corr.amount, description: corr.desc.trim() } }); }}>
                <Field label={t('hosting.correction_amount')}>{(p) => <MoneyInput {...p} value={corr.amount} onChange={(v) => setCorr({ ...corr, amount: v })} />}</Field>
                <Field label={t('hosting.correction_desc')} className="flex-1">{(p) => <Input {...p} value={corr.desc} maxLength={300} onChange={(e) => setCorr({ ...corr, desc: e.target.value })} />}</Field>
                <Button type="submit" variant="outline">{t('hosting.correction')}</Button>
              </form>
            ) : null}
          </Card>
          <ReasonDialog open={dialog !== null} onClose={() => setDialog(null)} title={t(dialog === 'reject' ? 'hosting.reject' : 'hosting.cancel')}
            onConfirm={async (reason: string) => { await act.mutateAsync(dialog === 'reject' ? { path: '/decision', body: { approve: false, note: reason } } : { path: '/cancel', body: { reason } }); setDialog(null); }} />
        </div>
      ) : null}
    </Drawer>
  );
}

// ── Spaces ──────────────────────────────────────────────────────────────────
function Spaces() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const list = useApiQuery<Listing[]>(['hosting-listings', access.slug], access.api('/hosting/listings'));
  const [edit, setEdit] = useState<string | 'new' | null>(null);
  const toast = useToast();
  const msg = useErrorMessage();
  const status = useApiMutation<{ id: string; status: string; version: number }, unknown>((v) => api(access.api(`/hosting/listings/${v.id}/status`), { body: { status: v.status, version: v.version } }), {
    onSuccess: async () => { await list.refetch(); toast({ tone: 'ok', text: t('hosting.saved') }); },
  });
  const manage = access.can('hosting.manage') && !access.readOnly;
  return (
    <div className="flex flex-col gap-3">
      {manage ? <div><Button icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>{t('hosting.listing.new')}</Button></div> : null}
      {status.error ? <FormErrorSummary message={msg(status.error)} /> : null}
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} /> : !list.data?.length ? <EmptyState title={t('hosting.empty.spaces')} /> : (
        <ul className="grid gap-3 md:grid-cols-2">{list.data.map((l) => (
          <li key={l.id} className="rounded-2xl border border-line bg-white p-4">
            <div className="flex items-start justify-between gap-2"><p className="font-semibold">{l.code} · {pick(l.title_ar, l.title_en) || l.resource_name}</p><Badge tone={l.status === 'published' ? 'ok' : 'neutral'}>{t(`hosting.status.${l.status}`)}</Badge></div>
            <p className="text-sm text-ink-muted">{l.branch_name} · {t(`hosting.listing.modes.${l.booking_mode}`)}</p>
            <p className="text-sm"><span dir="ltr">{money(l.price_minor)}</span> {t(`workspace.per.${l.price_model}`)}</p>
            {manage ? <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setEdit(l.id)}>{t('hosting.listing.edit')}</Button>
              {l.status !== 'published' ? <Button size="sm" onClick={() => status.mutate({ id: l.id, status: 'published', version: l.version })}>{t('hosting.listing.publish')}</Button>
                : <Button size="sm" variant="outline" onClick={() => status.mutate({ id: l.id, status: 'paused', version: l.version })}>{t('hosting.listing.pause')}</Button>}
            </div> : null}
          </li>))}</ul>
      )}
      {edit ? <ListingDrawer id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.refetch(); }} /> : null}
    </div>
  );
}

type Win = { weekday: number; start_time: string; end_time: string };
type Form = {
  branch_id: string; resource_id: string; code: string; title_ar: string; space_type: string; price_model: string; price_minor: number | null; period_min: number | null;
  min_duration_min: number; max_duration_min: number; setup_buffer_min: number; cleanup_buffer_min: number; booking_mode: string; addons_discount_pct: number;
  free_until_hours: number; fee_pct: number; grace_min: number; late_amount: number | null; access_instructions_ar: string; own_materials_policy_ar: string; specialties: string; windows: Win[];
  version?: number;
};

function ListingDrawer({ id, onClose, onSaved }: { id: string | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const existing = useApiQuery<any>(['hosting-listing', access.slug, id], id ? access.api(`/hosting/listings/${id}`) : null);
  const resources = useApiQuery<Array<{ id: string; name: string; branch_id: string }>>(['resources', access.slug], access.api('/resources'));
  const [f, setF] = useState<Form | null>(null);
  const [date, setDate] = useState('');
  const avail = useApiQuery<any>(['hosting-avail', id, date], id && date ? access.api(`/hosting/listings/${id}/availability?date=${date}`) : null);
  const form: Form | null = f ?? (id ? (existing.data ? {
    branch_id: existing.data.branch_id, resource_id: existing.data.resource_id, code: existing.data.code, title_ar: existing.data.title_ar ?? '', space_type: existing.data.space_type,
    price_model: existing.data.price_model, price_minor: existing.data.price_minor, period_min: existing.data.period_min, min_duration_min: existing.data.min_duration_min,
    max_duration_min: existing.data.max_duration_min, setup_buffer_min: existing.data.setup_buffer_min, cleanup_buffer_min: existing.data.cleanup_buffer_min,
    booking_mode: existing.data.booking_mode, addons_discount_pct: existing.data.addons_discount_bp / 100, free_until_hours: existing.data.cancellation_terms.free_until_hours,
    fee_pct: existing.data.cancellation_terms.fee_bp / 100, grace_min: existing.data.late_terms.grace_min, late_amount: existing.data.late_terms.amount_minor,
    access_instructions_ar: existing.data.access_instructions_ar ?? '', own_materials_policy_ar: existing.data.own_materials_policy_ar ?? '', specialties: (existing.data.specialties ?? []).join(', '),
    windows: existing.data.windows, version: existing.data.version,
  } : null) : {
    branch_id: '', resource_id: '', code: '', title_ar: '', space_type: 'chair', price_model: 'fixed_hour', price_minor: null, period_min: null, min_duration_min: 60, max_duration_min: 480,
    setup_buffer_min: 0, cleanup_buffer_min: 0, booking_mode: 'approval', addons_discount_pct: 0, free_until_hours: 24, fee_pct: 50, grace_min: 10, late_amount: 0,
    access_instructions_ar: '', own_materials_policy_ar: '', specialties: '', windows: [{ weekday: 0, start_time: '10:00', end_time: '18:00' }],
  });
  const set = (p: Partial<Form>) => setF({ ...(form as Form), ...p });
  const save = useApiMutation<void, unknown>(() => {
    const v = form!;
    const res = (resources.data ?? []).find((r) => r.id === v.resource_id);
    const body = {
      branch_id: res?.branch_id ?? v.branch_id, resource_id: v.resource_id, code: v.code.trim(), title_ar: v.title_ar || null, space_type: v.space_type, price_model: v.price_model,
      price_minor: v.price_minor ?? 0, period_min: v.price_model === 'fixed_period' ? v.period_min : null, min_duration_min: v.min_duration_min, max_duration_min: v.max_duration_min,
      setup_buffer_min: v.setup_buffer_min, cleanup_buffer_min: v.cleanup_buffer_min, booking_mode: v.booking_mode, addons_discount_bp: Math.round(v.addons_discount_pct * 100),
      cancellation_terms: { free_until_hours: v.free_until_hours, fee_bp: Math.round(v.fee_pct * 100) }, late_terms: { grace_min: v.grace_min, mode: 'per_15min', amount_minor: v.late_amount ?? 0 },
      access_instructions_ar: v.access_instructions_ar || null, own_materials_policy_ar: v.own_materials_policy_ar || null,
      specialties: v.specialties.split(/[,،]/).map((s) => s.trim()).filter(Boolean), windows: v.windows,
    };
    return id ? api(access.api(`/hosting/listings/${id}`), { method: 'PATCH', body: { ...body, version: v.version } }) : api(access.api('/hosting/listings'), { body });
  }, { onSuccess: onSaved });
  const num = (v: string) => Math.max(0, Number(v) || 0);
  return (
    <Drawer open wide onClose={onClose} title={t(id ? 'hosting.listing.edit' : 'hosting.listing.new')}>
      {!form ? <LoadingState /> : (
        <form className="flex flex-col gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          {save.error ? <FormErrorSummary message={msg(save.error)} /> : null}
          <Field label={t('hosting.listing.resource')} required>{(p) => <Select {...p} value={form.resource_id} onChange={(e) => set({ resource_id: e.target.value })} required>
            <option value="">—</option>{(resources.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('hosting.listing.code')} required>{(p) => <Input {...p} value={form.code} maxLength={20} onChange={(e) => set({ code: e.target.value })} required />}</Field>
            <Field label={t('hosting.listing.title')}>{(p) => <Input {...p} value={form.title_ar} maxLength={120} onChange={(e) => set({ title_ar: e.target.value })} />}</Field>
            <Field label={t('hosting.listing.type')}>{(p) => <Select {...p} value={form.space_type} onChange={(e) => set({ space_type: e.target.value })}>
              {['chair', 'station', 'room', 'other'].map((s) => <option key={s} value={s}>{t(`hosting.listing.types.${s}`)}</option>)}</Select>}</Field>
            <Field label={t('hosting.listing.mode')}>{(p) => <Select {...p} value={form.booking_mode} onChange={(e) => set({ booking_mode: e.target.value })}>
              {['approval', 'instant'].map((s) => <option key={s} value={s}>{t(`hosting.listing.modes.${s}`)}</option>)}</Select>}</Field>
            <Field label={t('hosting.listing.price_model')} hint={t('hosting.listing.percent_disabled')}>{(p) => <Select {...p} value={form.price_model} onChange={(e) => set({ price_model: e.target.value })}>
              {['fixed_hour', 'fixed_period', 'fixed_day'].map((s) => <option key={s} value={s}>{t(`hosting.listing.models.${s}`)}</option>)}</Select>}</Field>
            <Field label={t('hosting.listing.price')} required>{(p) => <MoneyInput {...p} value={form.price_minor} onChange={(v) => set({ price_minor: v })} />}</Field>
            {form.price_model === 'fixed_period' ? <Field label={t('hosting.listing.period')}>{(p) => <Input {...p} type="number" min={30} value={form.period_min ?? ''} onChange={(e) => set({ period_min: num(e.target.value) || null })} />}</Field> : null}
            <Field label={t('hosting.listing.min')}>{(p) => <Input {...p} type="number" min={15} value={form.min_duration_min} onChange={(e) => set({ min_duration_min: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.max')}>{(p) => <Input {...p} type="number" min={15} value={form.max_duration_min} onChange={(e) => set({ max_duration_min: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.setup')}>{(p) => <Input {...p} type="number" min={0} value={form.setup_buffer_min} onChange={(e) => set({ setup_buffer_min: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.cleanup')}>{(p) => <Input {...p} type="number" min={0} value={form.cleanup_buffer_min} onChange={(e) => set({ cleanup_buffer_min: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.addons_discount')}>{(p) => <Input {...p} type="number" min={0} max={100} value={form.addons_discount_pct} onChange={(e) => set({ addons_discount_pct: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.free_hours')}>{(p) => <Input {...p} type="number" min={0} value={form.free_until_hours} onChange={(e) => set({ free_until_hours: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.fee_pct')}>{(p) => <Input {...p} type="number" min={0} max={100} value={form.fee_pct} onChange={(e) => set({ fee_pct: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.grace')}>{(p) => <Input {...p} type="number" min={0} value={form.grace_min} onChange={(e) => set({ grace_min: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.late_amount')}>{(p) => <MoneyInput {...p} value={form.late_amount} onChange={(v) => set({ late_amount: v })} />}</Field>
          </div>
          <Field label={t('hosting.listing.specialties')}>{(p) => <Input {...p} value={form.specialties} onChange={(e) => set({ specialties: e.target.value })} />}</Field>
          <Field label={t('hosting.listing.access')}>{(p) => <Textarea {...p} value={form.access_instructions_ar} maxLength={2000} onChange={(e) => set({ access_instructions_ar: e.target.value })} />}</Field>
          <Field label={t('hosting.listing.own_materials')}>{(p) => <Textarea {...p} value={form.own_materials_policy_ar} maxLength={1000} onChange={(e) => set({ own_materials_policy_ar: e.target.value })} />}</Field>
          <Alert tone="info">{t('hosting.listing.no_materials_included')}</Alert>
          <fieldset className="flex flex-col gap-2"><legend className="font-medium">{t('hosting.listing.windows')}</legend>
            {form.windows.map((w, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <Field label={t('hosting.listing.weekday')}>{(p) => <Select {...p} value={w.weekday} onChange={(e) => set({ windows: form.windows.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)) })}>
                  {[0, 1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{t(`hosting.days.${d}`)}</option>)}</Select>}</Field>
                <Field label={t('hosting.listing.from')}>{(p) => <Input {...p} type="time" value={w.start_time} onChange={(e) => set({ windows: form.windows.map((x, j) => (j === i ? { ...x, start_time: e.target.value } : x)) })} />}</Field>
                <Field label={t('hosting.listing.to')}>{(p) => <Input {...p} type="time" value={w.end_time} onChange={(e) => set({ windows: form.windows.map((x, j) => (j === i ? { ...x, end_time: e.target.value } : x)) })} />}</Field>
                <Button size="sm" variant="outline" onClick={() => set({ windows: form.windows.filter((_, j) => j !== i) })}>×</Button>
              </div>))}
            <div><Button size="sm" variant="outline" onClick={() => set({ windows: [...form.windows, { weekday: 0, start_time: '10:00', end_time: '18:00' }] })}>{t('hosting.listing.add_window')}</Button></div>
          </fieldset>
          <div><Button type="submit" loading={save.isPending}>{t('hosting.listing.save')}</Button></div>
          {id ? (
            <Card title={t('hosting.availability')}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t('workspace.date')} />
              {avail.data ? <ul className="mt-2 flex flex-col gap-1">
                {avail.data.busy.map((b: { start: string; end: string; kind: string }, i: number) => <li key={`b${i}`}><Badge tone="warn">{t(`hosting.${b.kind}`)}</Badge> <TimeRange s={b.start} e={b.end} /></li>)}
                {avail.data.free.map((b: { start: string; end: string }, i: number) => <li key={`f${i}`}><Badge tone="ok">{t('hosting.free')}</Badge> <TimeRange s={b.start} e={b.end} /></li>)}
              </ul> : null}
            </Card>
          ) : null}
        </form>
      )}
    </Drawer>
  );
}

function TimeRange({ s, e }: { s: string; e: string }) {
  const { when } = useFmt();
  return <span>{when(s)} → {when(e)}</span>;
}

// ── Chair links ─────────────────────────────────────────────────────────────
function ChairLinks() {
  const { t } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const q = useApiQuery<Array<{ id: string; name: string; staff: Array<{ staff_id: string }> }>>(['hosting-links', access.slug], access.api('/hosting/links'));
  const staff = useApiQuery<Array<{ id: string; display_name: string }>>(['staff', access.slug], access.api('/staff'));
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const save = useApiMutation<string, unknown>((rid) => api(access.api('/hosting/links'), { method: 'PUT', body: { resource_id: rid, staff_ids: draft[rid] ?? [] } }), {
    onSuccess: async () => { await q.refetch(); toast({ tone: 'ok', text: t('hosting.saved') }); },
  });
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data?.length) return <EmptyState title={t('hosting.empty.chairs')} />;
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="info">{t('hosting.chairs_hint')}</Alert>
      {save.error ? <FormErrorSummary message={msg(save.error)} /> : null}
      {q.data.map((r) => {
        const sel = draft[r.id] ?? r.staff.map((s) => s.staff_id);
        return (
          <Card key={r.id} title={r.name}>
            <div className="flex flex-wrap gap-3">{(staff.data ?? []).map((s) => (
              <Checkbox key={s.id} label={s.display_name} checked={sel.includes(s.id)} disabled={!access.can('hosting.manage')}
                onChange={(v) => setDraft({ ...draft, [r.id]: v ? [...sel, s.id] : sel.filter((x) => x !== s.id) })} />))}</div>
            {access.can('hosting.manage') ? <Button className="mt-2" size="sm" onClick={() => save.mutate(r.id)}>{t('hosting.save_links')}</Button> : null}
          </Card>
        );
      })}
    </div>
  );
}

function Money() {
  const { t } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const q = useApiQuery<any>(['hosting-summary', access.slug], access.hasFeature('hosting.reports') ? access.api('/hosting/summary') : null);
  if (!access.hasFeature('hosting.reports')) return <Alert tone="info">{t('errors.plan_feature_unavailable')}</Alert>;
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={t('hosting.money.revenue')} value={<span dir="ltr">{money(d.hosting_revenue_minor)}</span>} />
        <Stat label={t('hosting.money.products')} value={<span dir="ltr">{money(d.product_addon_sales_minor)}</span>} />
        <Stat label={t('hosting.money.receivable')} value={<span dir="ltr">{money(d.receivable_minor)}</span>} tone={d.receivable_minor > 0 ? 'warn' : undefined} />
        <Stat label={t('hosting.money.refunds')} value={<span dir="ltr">{money(d.refunds_minor)}</span>} />
      </div>
      <p className="text-xs text-ink-muted">{t('hosting.money.basis')}: {t('hosting.money.basis_text')}</p>
      <p className="text-xs text-ink-muted">{t('hosting.statement.platform_fee')}: <span dir="ltr">{money(0)}</span></p>
    </div>
  );
}
