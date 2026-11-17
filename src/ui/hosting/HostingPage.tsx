'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Armchair, CalendarClock, Plus, ScanLine, ShieldCheck, Trash2, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button, IconButton } from '../components/button';
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
          <button type="button" onClick={() => onOpen(r.id)} className="flex w-full flex-col gap-1 rounded-2xl border border-line bg-surface p-4 text-start hover:border-line-strong focus-visible:outline-2">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-heading"><bdi>{r.guest_name}</bdi> · {r.space_code}</p>
              <Badge tone={TONE[r.status] ?? 'neutral'}>{t(`hosting.status.${r.status}`)}</Badge>
            </div>
            <p className="flex items-center gap-1 text-sm"><CalendarClock className="size-4 text-ink-muted" aria-hidden />{when(r.starts_at)} → {when(r.ends_at)}</p>
            <p className="text-sm">{t('hosting.total')}: <span dir="ltr">{money(r.total_minor)}</span> <span dir="ltr" className="ms-2 text-xs text-ink-muted">{r.number}</span></p>
            {r.status === 'pending_approval' && r.hold_expires_at ? <p className="text-xs text-warn">{t('hosting.respond_by', { when: when(r.hold_expires_at) })}</p> : null}
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
      {scan.error ? <p role="alert" className="mt-2 text-sm text-danger">{msg(scan.error)}</p> : null}
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
            {b.status === 'pending_approval' && b.approval_deadline ? <span className="text-xs text-warn">{t('hosting.respond_by', { when: when(b.approval_deadline) })}</span> : null}</div>
          <Alert tone="info"><span className="inline-flex items-center gap-1"><ShieldCheck className="size-4" aria-hidden />{t('hosting.privacy_note')}</span></Alert>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-ink-muted">{t('hosting.guest')}</dt><dd><bdi>{b.guest.name}</bdi>{b.guest.provider_name ? ` — ${b.guest.provider_name}` : ''}</dd>
            <dt className="text-ink-muted">{t('hosting.when')}</dt><dd>{when(b.starts_at)} → {when(b.ends_at)}</dd>
          </dl>
          {['confirmed', 'checked_in', 'in_use'].includes(b.status) ? <p className="rounded-xl bg-surface-muted p-3 font-medium" dir="auto">{t('hosting.code_for_guest', { code: b.check_in_code })}</p> : null}
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
type Options = {
  resources: Array<{ id: string; name: string; branch_id: string; branch_name: string; type_name_ar: string | null; type_name_en: string | null; listing_id: string | null }>;
  products: Array<{ variant_id: string; name_ar: string | null; name_en: string | null; variant_name_ar: string | null; variant_name_en: string | null; price_minor: number; sku: string | null }>;
  payment_account_ready: boolean;
};

function Spaces() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const list = useApiQuery<Listing[]>(['hosting-listings', access.slug], access.api('/hosting/listings'));
  const options = useApiQuery<Options>(['hosting-listing-options', access.slug], access.api('/hosting/listing-options'));
  const [edit, setEdit] = useState<string | 'new' | null>(null);
  const toast = useToast();
  const msg = useErrorMessage();
  const status = useApiMutation<{ id: string; status: string; version: number }, unknown>((v) => api(access.api(`/hosting/listings/${v.id}/status`), { body: { status: v.status, version: v.version } }), {
    onSuccess: async () => { await list.refetch(); toast({ tone: 'ok', text: t('hosting.saved') }); },
  });
  const manage = access.can('hosting.manage') && !access.readOnly;
  const noChairs = options.data ? options.data.resources.length === 0 : false;
  const canAddResources = access.can('catalog.edit');
  const resourcesLink = canAddResources ? <Link className="font-medium text-link underline underline-offset-2" href={`/app/${access.slug}/services?tab=resources`}>{t('hosting.listing.go_resources')}</Link> : null;
  return (
    <div className="flex flex-col gap-3">
      {manage ? <div><Button icon={<Plus className="size-4" />} disabled={!options.data || noChairs} onClick={() => setEdit('new')}>{t('hosting.listing.new')}</Button></div> : null}
      {options.error ? <ErrorState error={options.error} onRetry={() => options.refetch()} /> : null}
      {manage && noChairs ? <Alert tone="info" title={t('hosting.listing.no_chairs_title')}>{t(canAddResources ? 'hosting.listing.no_chairs' : 'hosting.listing.no_chairs_ask')} {resourcesLink}</Alert> : null}
      {manage && options.data && !options.data.payment_account_ready ? (
        <Alert tone="warn">{t('hosting.listing.payment_needed')} {access.can('payments.configure', 'business.manage') ? <Link className="font-medium underline underline-offset-2" href={`/app/${access.slug}/settings?tab=payments`}>{t('hosting.listing.go_payments')}</Link> : null}</Alert>
      ) : null}
      {status.error ? <FormErrorSummary message={msg(status.error)} /> : null}
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
        <EmptyState icon={<Armchair className="size-8" aria-hidden />} title={t('hosting.empty.spaces')} hint={manage && !noChairs ? t('hosting.listing.first_hint') : undefined} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">{list.data.map((l) => (
          <li key={l.id} className="min-w-0 rounded-2xl border border-line bg-surface p-4" data-testid={`listing-${l.code}`}>
            <div className="flex items-start justify-between gap-2"><p className="min-w-0 font-semibold">{l.code} · {pick(l.title_ar, l.title_en) || l.resource_name}</p><Badge tone={l.status === 'published' ? 'ok' : 'neutral'}>{t(`hosting.status.${l.status}`)}</Badge></div>
            <p className="text-sm text-ink-muted">{l.resource_name} · {l.branch_name} · {t(`hosting.listing.modes.${l.booking_mode}`)}</p>
            <p className="text-sm"><span dir="ltr">{money(l.price_minor)}</span> {t(`workspace.per.${l.price_model}`)}</p>
            {manage ? <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setEdit(l.id)}>{t('hosting.listing.edit')}</Button>
              {l.status !== 'published' ? <Button size="sm" loading={status.isPending && status.variables?.id === l.id} onClick={() => status.mutate({ id: l.id, status: 'published', version: l.version })}>{t('hosting.listing.publish')}</Button>
                : <Button size="sm" variant="outline" onClick={() => status.mutate({ id: l.id, status: 'paused', version: l.version })}>{t('hosting.listing.pause')}</Button>}
            </div> : null}
          </li>))}</ul>
      )}
      {edit && options.data ? <ListingDrawer id={edit === 'new' ? null : edit} options={options.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.refetch(); options.refetch(); toast({ tone: 'ok', text: t('hosting.saved') }); }} /> : null}
    </div>
  );
}

type Win = { weekday: number; start_time: string; end_time: string };
type AddonRow =
  | { kind: 'product'; product_variant_id: string; max_quantity: number }
  | { kind: 'equipment'; resource_id: string; name_ar: string; rental_price_minor: number | null; rental_unit: 'booking' | 'hour' };
type Form = {
  resource_id: string; code: string; title_ar: string; space_type: string; price_model: string; price_minor: number | null; period_min: number | null;
  min_duration_min: number; max_duration_min: number; setup_buffer_min: number; cleanup_buffer_min: number; booking_mode: string; addons_discount_pct: number;
  free_until_hours: number; fee_pct: number; grace_min: number; late_amount: number | null; access_instructions_ar: string; own_materials_policy_ar: string; specialties: string; windows: Win[];
  addons: AddonRow[];
  version?: number;
};

const EMPTY_FORM: Form = {
  resource_id: '', code: '', title_ar: '', space_type: 'chair', price_model: 'fixed_hour', price_minor: null, period_min: null, min_duration_min: 60, max_duration_min: 480,
  setup_buffer_min: 0, cleanup_buffer_min: 0, booking_mode: 'approval', addons_discount_pct: 0, free_until_hours: 24, fee_pct: 50, grace_min: 10, late_amount: 0,
  access_instructions_ar: '', own_materials_policy_ar: '', specialties: '', windows: [{ weekday: 0, start_time: '10:00', end_time: '18:00' }], addons: [],
};

function fromListing(d: any): Form {
  return {
    resource_id: d.resource_id, code: d.code, title_ar: d.title_ar ?? '', space_type: d.space_type, price_model: d.price_model, price_minor: d.price_minor, period_min: d.period_min,
    min_duration_min: d.min_duration_min, max_duration_min: d.max_duration_min, setup_buffer_min: d.setup_buffer_min, cleanup_buffer_min: d.cleanup_buffer_min,
    booking_mode: d.booking_mode, addons_discount_pct: d.addons_discount_bp / 100, free_until_hours: d.cancellation_terms.free_until_hours,
    fee_pct: d.cancellation_terms.fee_bp / 100, grace_min: d.late_terms.grace_min, late_amount: d.late_terms.amount_minor,
    access_instructions_ar: d.access_instructions_ar ?? '', own_materials_policy_ar: d.own_materials_policy_ar ?? '', specialties: (d.specialties ?? []).join(', '),
    windows: d.windows, version: d.version,
    addons: (d.addons ?? []).map((a: any): AddonRow => (a.kind === 'product'
      ? { kind: 'product', product_variant_id: a.product_variant_id, max_quantity: a.max_quantity }
      : { kind: 'equipment', resource_id: a.resource_id, name_ar: a.name_ar ?? '', rental_price_minor: a.rental_price_minor, rental_unit: a.rental_unit })),
  };
}

function ListingDrawer({ id, options, onClose, onSaved }: { id: string | null; options: Options; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const existing = useApiQuery(['hosting-listing', access.slug, id], id ? access.api(`/hosting/listings/${id}`) : null);
  const [f, setF] = useState<Form | null>(null);
  const [date, setDate] = useState('');
  const avail = useApiQuery(['hosting-avail', id, date], id && date ? access.api(`/hosting/listings/${id}/availability?date=${date}`) : null);
  const form: Form | null = f ?? (id ? (existing.data ? fromListing(existing.data) : null) : EMPTY_FORM);
  const set = (p: Partial<Form>) => setF({ ...(form as Form), ...p });
  // A chair or room can carry one listing: offer the free ones (and this listing's own).
  const chairs = options.resources.filter((r) => !r.listing_id || r.listing_id === id);
  const chair = options.resources.find((r) => r.id === form?.resource_id) ?? null;
  const equipmentChoices = options.resources.filter((r) => chair && r.branch_id === chair.branch_id && r.id !== chair.id);
  const save = useApiMutation<void, unknown>(() => {
    const v = form!;
    const body = {
      branch_id: chair?.branch_id, resource_id: v.resource_id, code: v.code.trim(), title_ar: v.title_ar || null, space_type: v.space_type, price_model: v.price_model,
      price_minor: v.price_minor ?? 0, period_min: v.price_model === 'fixed_period' ? v.period_min : null, min_duration_min: v.min_duration_min, max_duration_min: v.max_duration_min,
      setup_buffer_min: v.setup_buffer_min, cleanup_buffer_min: v.cleanup_buffer_min, booking_mode: v.booking_mode, addons_discount_bp: Math.round(v.addons_discount_pct * 100),
      cancellation_terms: { free_until_hours: v.free_until_hours, fee_bp: Math.round(v.fee_pct * 100) }, late_terms: { grace_min: v.grace_min, mode: 'per_15min', amount_minor: v.late_amount ?? 0 },
      access_instructions_ar: v.access_instructions_ar || null, own_materials_policy_ar: v.own_materials_policy_ar || null,
      specialties: v.specialties.split(/[,،]/).map((s) => s.trim()).filter(Boolean), windows: v.windows,
      addons: v.addons.map((a) => (a.kind === 'product'
        ? { kind: 'product', product_variant_id: a.product_variant_id, max_quantity: a.max_quantity }
        : { kind: 'equipment', resource_id: a.resource_id, name_ar: a.name_ar.trim() || null, rental_price_minor: a.rental_price_minor ?? 0, rental_unit: a.rental_unit })),
    };
    return id ? api(access.api(`/hosting/listings/${id}`), { method: 'PATCH', body: { ...body, version: v.version } }) : api(access.api('/hosting/listings'), { body });
  }, { onSuccess: onSaved });
  const num = (v: string) => Math.max(0, Number(v) || 0);
  const incomplete = form ? form.addons.some((a) => (a.kind === 'product' ? !a.product_variant_id : !a.resource_id)) : true;
  return (
    <Drawer open wide onClose={onClose} title={t(id ? 'hosting.listing.edit' : 'hosting.listing.new')}>
      {id && existing.error ? <ErrorState error={existing.error} onRetry={() => existing.refetch()} /> : !form ? <LoadingState /> : !chairs.length ? (
        <EmptyState icon={<Armchair className="size-8" aria-hidden />} title={t('hosting.listing.no_chairs_title')} hint={t(access.can('catalog.edit') ? 'hosting.listing.no_chairs' : 'hosting.listing.no_chairs_ask')}
          action={access.can('catalog.edit') ? <Link className="font-medium text-link underline underline-offset-2" href={`/app/${access.slug}/services?tab=resources`}>{t('hosting.listing.go_resources')}</Link> : null} />
      ) : (
        <form className="flex flex-col gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          {save.error ? <FormErrorSummary message={msg(save.error)} /> : null}
          <Field label={t('hosting.listing.resource')} required hint={chair ? `${t('hosting.listing.branch')}: ${chair.branch_name}` : undefined}>{(p) => <Select {...p} value={form.resource_id} onChange={(e) => set({ resource_id: e.target.value, addons: form.addons.filter((a) => a.kind === 'product') })} required>
            <option value="">—</option>{chairs.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.branch_name}</option>)}</Select>}</Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('hosting.listing.code')} required>{(p) => <Input {...p} value={form.code} maxLength={20} onChange={(e) => set({ code: e.target.value })} required />}</Field>
            <Field label={t('hosting.listing.title')}>{(p) => <Input {...p} value={form.title_ar} maxLength={120} onChange={(e) => set({ title_ar: e.target.value })} />}</Field>
            <Field label={t('hosting.listing.type')}>{(p) => <Select {...p} value={form.space_type} onChange={(e) => set({ space_type: e.target.value })}>
              {['chair', 'station', 'room', 'other'].map((s) => <option key={s} value={s}>{t(`hosting.listing.types.${s}`)}</option>)}</Select>}</Field>
            <Field label={t('hosting.listing.mode')}>{(p) => <Select {...p} value={form.booking_mode} onChange={(e) => set({ booking_mode: e.target.value })}>
              {['approval', 'instant'].map((s) => <option key={s} value={s}>{t(`hosting.listing.modes.${s}`)}</option>)}</Select>}</Field>
            <Field label={t('hosting.listing.price_model')} hint={t('hosting.listing.percent_disabled')}>{(p) => <Select {...p} value={form.price_model} onChange={(e) => set({ price_model: e.target.value })}>
              {['fixed_hour', 'fixed_period', 'fixed_day'].map((s) => <option key={s} value={s}>{t(`hosting.listing.models.${s}`)}</option>)}</Select>}</Field>
            <Field label={t('hosting.listing.price')} required hint={t('hosting.listing.price_hint')}>{(p) => <MoneyInput {...p} value={form.price_minor} onChange={(v) => set({ price_minor: v })} />}</Field>
            {form.price_model === 'fixed_period' ? <Field label={t('hosting.listing.period')}>{(p) => <Input {...p} type="number" min={30} value={form.period_min ?? ''} onChange={(e) => set({ period_min: num(e.target.value) || null })} />}</Field> : null}
            <Field label={t('hosting.listing.min')}>{(p) => <Input {...p} type="number" min={15} value={form.min_duration_min} onChange={(e) => set({ min_duration_min: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.max')}>{(p) => <Input {...p} type="number" min={15} value={form.max_duration_min} onChange={(e) => set({ max_duration_min: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.setup')}>{(p) => <Input {...p} type="number" min={0} value={form.setup_buffer_min} onChange={(e) => set({ setup_buffer_min: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.cleanup')}>{(p) => <Input {...p} type="number" min={0} value={form.cleanup_buffer_min} onChange={(e) => set({ cleanup_buffer_min: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.free_hours')}>{(p) => <Input {...p} type="number" min={0} value={form.free_until_hours} onChange={(e) => set({ free_until_hours: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.fee_pct')}>{(p) => <Input {...p} type="number" min={0} max={100} value={form.fee_pct} onChange={(e) => set({ fee_pct: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.grace')}>{(p) => <Input {...p} type="number" min={0} value={form.grace_min} onChange={(e) => set({ grace_min: num(e.target.value) })} />}</Field>
            <Field label={t('hosting.listing.late_amount')}>{(p) => <MoneyInput {...p} value={form.late_amount} onChange={(v) => set({ late_amount: v })} />}</Field>
          </div>
          <Field label={t('hosting.listing.specialties')}>{(p) => <Input {...p} value={form.specialties} onChange={(e) => set({ specialties: e.target.value })} />}</Field>
          <Field label={t('hosting.listing.access')}>{(p) => <Textarea {...p} value={form.access_instructions_ar} maxLength={2000} onChange={(e) => set({ access_instructions_ar: e.target.value })} />}</Field>
          <Field label={t('hosting.listing.own_materials')}>{(p) => <Textarea {...p} value={form.own_materials_policy_ar} maxLength={1000} onChange={(e) => set({ own_materials_policy_ar: e.target.value })} />}</Field>
          <fieldset className="flex flex-col gap-2"><legend className="font-medium">{t('hosting.listing.windows')}</legend>
            {form.windows.map((w, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <Field label={t('hosting.listing.weekday')}>{(p) => <Select {...p} value={w.weekday} onChange={(e) => set({ windows: form.windows.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)) })}>
                  {[0, 1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{t(`hosting.days.${d}`)}</option>)}</Select>}</Field>
                <Field label={t('hosting.listing.from')}>{(p) => <Input {...p} type="time" value={w.start_time} onChange={(e) => set({ windows: form.windows.map((x, j) => (j === i ? { ...x, start_time: e.target.value } : x)) })} />}</Field>
                <Field label={t('hosting.listing.to')}>{(p) => <Input {...p} type="time" value={w.end_time} onChange={(e) => set({ windows: form.windows.map((x, j) => (j === i ? { ...x, end_time: e.target.value } : x)) })} />}</Field>
                <IconButton label={t('hosting.listing.remove_window')} onClick={() => set({ windows: form.windows.filter((_, j) => j !== i) })}><X className="size-4" aria-hidden /></IconButton>
              </div>))}
            <div><Button size="sm" variant="outline" onClick={() => set({ windows: [...form.windows, { weekday: 0, start_time: '10:00', end_time: '18:00' }] })}>{t('hosting.listing.add_window')}</Button></div>
          </fieldset>
          <AddonEditor form={form} set={set} options={options} equipment={equipmentChoices} hasChair={!!chair} />
          <div><Button type="submit" loading={save.isPending} disabled={incomplete}>{t('hosting.listing.save')}</Button></div>
          {id ? (
            <Card title={t('hosting.availability')}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t('workspace.date')} />
              {avail.isLoading ? <LoadingState rows={1} /> : avail.error ? <ErrorState error={avail.error} /> : avail.data ? <ul className="mt-2 flex flex-col gap-1">
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

/**
 * D5/D5b/D6: no materials are included in the rent. Add-ons are whole store
 * products at the current store price (minus the listing-wide add-ons discount)
 * or equipment rented as a shared resource of the same branch.
 */
function AddonEditor({ form, set, options, equipment, hasChair }: { form: Form; set: (p: Partial<Form>) => void; options: Options; equipment: Options['resources']; hasChair: boolean }) {
  const { t, pick } = useI18n();
  const { money } = useFmt();
  const access = useAccess();
  const num = (v: string) => Math.max(0, Number(v) || 0);
  const update = (i: number, patch: Partial<AddonRow>) => set({ addons: form.addons.map((a, j) => (j === i ? ({ ...a, ...patch } as AddonRow) : a)) });
  const remove = (i: number) => set({ addons: form.addons.filter((_, j) => j !== i) });
  const pct = form.addons_discount_pct;
  const label = (p: Options['products'][number]) => [pick(p.name_ar, p.name_en), pick(p.variant_name_ar, p.variant_name_en)].filter(Boolean).join(' · ');
  return (
    <fieldset className="flex flex-col gap-3 rounded-2xl border border-line p-3">
      <legend className="px-1 font-medium">{t('hosting.listing.addons')}</legend>
      <Alert tone="info">{t('hosting.listing.no_materials_included')}</Alert>
      <Field label={t('hosting.listing.addons_discount')} hint={t('hosting.listing.addons_discount_hint')} className="sm:max-w-xs">{(p) => <Input {...p} type="number" min={0} max={100} value={form.addons_discount_pct} onChange={(e) => set({ addons_discount_pct: Math.min(100, num(e.target.value)) })} />}</Field>
      {form.addons.length ? (
        <ul className="flex flex-col gap-3">{form.addons.map((a, i) => {
          const prod = a.kind === 'product' ? options.products.find((p) => p.variant_id === a.product_variant_id) : null;
          return (
            <li key={i} className="flex flex-col gap-2 rounded-xl bg-surface-muted p-3" data-testid="addon-row">
              <div className="flex items-center justify-between gap-2"><Badge tone="brand">{t(`hosting.listing.addon_kinds.${a.kind}`)}</Badge>
                <IconButton label={t('hosting.listing.remove_addon')} onClick={() => remove(i)}><Trash2 className="size-4" aria-hidden /></IconButton></div>
              {a.kind === 'product' ? (
                <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
                  <Field label={t('hosting.listing.addon_product')} required>{(p) => <Select {...p} value={a.product_variant_id} onChange={(e) => update(i, { product_variant_id: e.target.value })}>
                    <option value="">—</option>{options.products.map((o) => <option key={o.variant_id} value={o.variant_id}>{label(o)} · {money(o.price_minor)}</option>)}</Select>}</Field>
                  <Field label={t('hosting.listing.addon_max')}>{(p) => <Input {...p} type="number" min={1} max={50} value={a.max_quantity} onChange={(e) => update(i, { max_quantity: Math.min(50, Math.max(1, num(e.target.value))) })} />}</Field>
                  {prod ? <p className="text-xs text-ink-muted sm:col-span-2">{t('hosting.listing.store_price', { price: money(prod.price_minor) })}{pct > 0 ? ` · ${t('hosting.listing.after_discount', { price: money(Math.round(prod.price_minor * (1 - pct / 100))), pct })}` : ''}</p> : null}
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label={t('hosting.listing.addon_equipment')} required>{(p) => <Select {...p} value={a.resource_id} onChange={(e) => update(i, { resource_id: e.target.value })}>
                    <option value="">—</option>{equipment.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>
                  <Field label={t('hosting.listing.addon_name')}>{(p) => <Input {...p} value={a.name_ar} maxLength={120} onChange={(e) => update(i, { name_ar: e.target.value })} />}</Field>
                  <Field label={t('hosting.listing.addon_rental')} required>{(p) => <MoneyInput {...p} value={a.rental_price_minor} onChange={(v) => update(i, { rental_price_minor: v })} />}</Field>
                  <Field label={t('hosting.listing.addon_unit')}>{(p) => <Select {...p} value={a.rental_unit} onChange={(e) => update(i, { rental_unit: e.target.value as 'booking' | 'hour' })}>
                    {(['booking', 'hour'] as const).map((u) => <option key={u} value={u}>{t(`hosting.listing.rental_units.${u}`)}</option>)}</Select>}</Field>
                  <p className="text-xs text-ink-muted sm:col-span-2">{t('hosting.listing.equipment_shared')}</p>
                </div>
              )}
            </li>
          );
        })}</ul>
      ) : <p className="text-ink-muted">{t('hosting.listing.no_addons')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" icon={<Plus className="size-4" />} disabled={!options.products.length} onClick={() => set({ addons: [...form.addons, { kind: 'product', product_variant_id: '', max_quantity: 5 }] })}>{t('hosting.listing.add_product')}</Button>
        <Button size="sm" variant="outline" icon={<Plus className="size-4" />} disabled={!hasChair || !equipment.length} onClick={() => set({ addons: [...form.addons, { kind: 'equipment', resource_id: '', name_ar: '', rental_price_minor: null, rental_unit: 'booking' }] })}>{t('hosting.listing.add_equipment')}</Button>
      </div>
      {!options.products.length ? <p className="text-xs text-ink-muted">{t('hosting.listing.no_products')}{access.can('catalog.edit') ? <> <Link className="underline" href={`/app/${access.slug}/products`}>{t('hosting.listing.go_products')}</Link></> : null}</p> : null}
      {hasChair && !equipment.length ? <p className="text-xs text-ink-muted">{t('hosting.listing.no_equipment')}</p> : null}
    </fieldset>
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
