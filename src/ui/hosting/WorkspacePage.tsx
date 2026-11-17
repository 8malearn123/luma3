'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CalendarClock, MapPin, Search, Star } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, PageHeader, Stat, Tabs } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { ReasonDialog } from '../engagement/shared';
import { encodeQr, qrSvg } from '@/shared/qr';
import { StatementTable, TONE, type Statement } from './shared';

type Result = {
  id: string; host: { name: string }; branch: { name: string; city: string | null; address: string | null }; code: string; title_ar: string | null; title_en: string | null; space_type: string;
  price_model: string; price_minor: number; base_total_minor: number; booking_mode: string; rating: { average: number | null; count: number }; distance_km: number | null;
  availability: { free: Array<{ start: string; end: string }>; fits: boolean | null };
};
type Row = { id: string; number: string; status: string; starts_at: string; ends_at: string; total_minor: number; host: { name?: string; branch_name?: string }; space_code: string };

const TABS = ['search', 'upcoming', 'past', 'expenses'] as const;
type Tab = (typeof TABS)[number];
const UPCOMING = ['pending_approval', 'held', 'pending_payment', 'confirmed', 'checked_in', 'in_use'];

/** «احجزي مساحة عمل»: search → details (full price, terms) → book → pay or await approval → confirmation. */
export function WorkspacePage() {
  const { t } = useI18n();
  const access = useAccess();
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>('search');
  const list = useApiQuery<Row[]>(['ws-bookings', access.slug], access.api('/workspace/bookings'));
  const openId = params.get('booking');
  const open = (id: string | null) => router.replace(id ? `?booking=${id}` : '?', { scroll: false });
  return (
    <div>
      <PageHeader title={t('workspace.title')} subtitle={t('workspace.subtitle')} />
      <Tabs value={tab} onChange={setTab} items={TABS.map((v) => ({ value: v, label: t(`workspace.tabs.${v}`) }))} />
      {tab === 'search' ? <SearchPanel onBooked={(id) => { list.refetch(); open(id); }} />
        : tab === 'expenses' ? <Expenses />
          : list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} /> : (
            <MyBookings rows={(list.data ?? []).filter((r) => (tab === 'upcoming') === UPCOMING.includes(r.status))} onOpen={open} />
          )}
      {openId ? <BookingDrawer id={openId} onClose={() => open(null)} onChanged={() => list.refetch()} /> : null}
    </div>
  );
}

function SearchPanel({ onBooked }: { onBooked: (id: string) => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const [f, setF] = useState({ city: '', date: '', start_time: '', duration_min: '120', space_type: '', specialty: '', equipment: '', sort: 'price' });
  const [query, setQuery] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const res = useApiQuery<{ results: Result[]; distance_available: boolean }>(['ws-search', query], query ? access.api(`/workspace/search?${query}`) : null);
  const submit = () => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    setQuery(q.toString());
  };
  return (
    <div className="flex flex-col gap-3">
      <form className="grid gap-3 rounded-2xl border border-line bg-white p-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); if (f.date) submit(); }}>
        <Field label={t('workspace.city')}>{(p) => <Input {...p} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />}</Field>
        <Field label={t('workspace.date')} required>{(p) => <Input {...p} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required />}</Field>
        <Field label={t('workspace.start')}>{(p) => <Input {...p} type="time" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} />}</Field>
        <Field label={t('workspace.duration')}>{(p) => <Input {...p} type="number" min={15} step={15} value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: e.target.value })} />}</Field>
        <Field label={t('workspace.type')}>{(p) => <Select {...p} value={f.space_type} onChange={(e) => setF({ ...f, space_type: e.target.value })}>
          <option value="">{t('workspace.any')}</option>{['chair', 'station', 'room', 'other'].map((s) => <option key={s} value={s}>{t(`hosting.listing.types.${s}`)}</option>)}</Select>}</Field>
        <Field label={t('workspace.specialty')}>{(p) => <Input {...p} value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })} />}</Field>
        <Field label={t('workspace.equipment')}>{(p) => <Input {...p} value={f.equipment} onChange={(e) => setF({ ...f, equipment: e.target.value })} />}</Field>
        <Field label={t('workspace.sort')}>{(p) => <Select {...p} value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}>
          {['price', 'distance', 'rating', 'equipment_fit'].map((s) => <option key={s} value={s}>{t(`workspace.sorts.${s}`)}</option>)}</Select>}</Field>
        <div className="sm:col-span-4"><Button type="submit" icon={<Search className="size-4" />} disabled={!f.date}>{t('workspace.search')}</Button></div>
      </form>
      {res.data && !res.data.distance_available && f.sort === 'distance' ? <Alert tone="info">{t('workspace.distance_off')}</Alert> : null}
      {res.isLoading ? <LoadingState /> : res.error ? <ErrorState error={res.error} /> : res.data ? (!res.data.results.length ? <EmptyState title={t('workspace.no_results')} /> : (
        <ul className="grid gap-3 md:grid-cols-2">{res.data.results.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => setDetail(r.id)} className="flex w-full flex-col gap-1 rounded-2xl border border-line bg-white p-4 text-start hover:border-luma-300 focus-visible:outline-2">
              <p className="font-semibold">{r.host.name} · {pick(r.title_ar, r.title_en) || r.code}</p>
              <p className="flex items-center gap-1 text-sm text-ink-muted"><MapPin className="size-4" aria-hidden />{r.branch.name}{r.branch.city ? ` — ${r.branch.city}` : ''}{r.distance_km != null ? ` · ${t('workspace.km', { n: r.distance_km })}` : ''}</p>
              <p className="text-sm">{t('workspace.base_price')}: <span dir="ltr">{money(r.price_minor)}</span> {t(`workspace.per.${r.price_model}`)}</p>
              <p className="text-sm">{t('workspace.price_label_base')} ({t('workspace.minutes', { n: Number(new URLSearchParams(query ?? '').get('duration_min')) || 120 })}): <span dir="ltr" className="font-semibold">{money(r.base_total_minor)}</span></p>
              <p className="flex items-center gap-1 text-xs text-ink-muted"><Star className="size-3.5" aria-hidden />{r.rating.average != null ? t('workspace.rating', { avg: r.rating.average, n: r.rating.count }) : t('workspace.no_rating')} · {t(`workspace.${r.booking_mode}`)}</p>
              {r.availability.free.slice(0, 3).map((w, i) => <p key={i} className="text-xs"><Badge tone="ok">{t('hosting.free')}</Badge> {when(w.start)} → {when(w.end)}</p>)}
            </button>
          </li>))}</ul>
      )) : null}
      {detail && query ? <ListingDrawer id={detail} search={new URLSearchParams(query)} onClose={() => setDetail(null)} onBooked={(id) => { setDetail(null); onBooked(id); }} /> : null}
    </div>
  );
}

function ListingDrawer({ id, search, onClose, onBooked }: { id: string; search: URLSearchParams; onClose: () => void; onBooked: (id: string) => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const msg = useErrorMessage();
  const toast = useToast();
  const date = search.get('date') ?? '';
  const duration = Number(search.get('duration_min') ?? 120);
  const d = useApiQuery<any>(['ws-listing', id, date, duration], access.api(`/workspace/listings/${id}?date=${date}&duration_min=${duration}`));
  const [qty, setQty] = useState<Record<string, number>>({});
  const [start, setStart] = useState(search.get('start_time') ?? '');
  const addons = useMemo(() => Object.entries(qty).filter(([, n]) => n > 0).map(([addon_id, quantity]) => ({ addon_id, quantity })), [qty]);
  const [priced, setPriced] = useState<Priced | null>(null);
  const price = useApiMutation<void, Priced>(() => api(access.api('/workspace/quote'), { body: { listing_id: id, duration_min: duration, addons } }), { onSuccess: (r) => setPriced(r) });
  const book = useApiMutation<void, { id: string }>((_, ctx) => {
    const tz = d.data.branch.timezone as string;
    const local = `${date}T${start}:00`;
    // The browser sends the wall-clock time with the branch's offset; the server validates everything.
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(`${local}Z`)).find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00';
    return api(access.api('/workspace/bookings'), { idempotencyKey: ctx.idempotencyKey, body: { listing_id: id, start: `${local}${offset === '' ? '+00:00' : offset}`, duration_min: duration, addons, terms_version: d.data.terms_version } });
  }, { onSuccess: (r) => { toast({ tone: 'ok', text: t('workspace.requested_ok') }); onBooked(r.id); } });
  const l = d.data;
  return (
    <Drawer open wide onClose={onClose} title={l ? `${l.host.name} · ${l.code}` : t('states.loading')}>
      {d.isLoading ? <LoadingState /> : d.error ? <ErrorState error={d.error} /> : l ? (
        <div className="flex flex-col gap-4 text-sm">
          <p>{pick(l.description_ar, l.description_en)}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-ink-muted">{t('workspace.inclusions')}</dt><dd>{l.inclusions.equipment.length ? l.inclusions.equipment.join('، ') : '—'}</dd>
            <dt className="text-ink-muted">{t('workspace.exclusions')}</dt><dd>{t('workspace.no_materials')}</dd>
            <dt className="text-ink-muted">{t('workspace.terms')}</dt><dd>
              <p>{t('workspace.cancellation', { h: l.cancellation_terms.free_until_hours, pct: l.cancellation_terms.fee_bp / 100 })}</p>
              <p>{t('workspace.late', { g: l.late_terms.grace_min })}</p>
              <p>{t(`workspace.${l.booking_mode}`)}</p>
              {pick(l.own_materials_policy_ar, l.own_materials_policy_en) ? <p>{pick(l.own_materials_policy_ar, l.own_materials_policy_en)}</p> : null}
            </dd>
          </dl>
          {l.addons.length ? (
            <Card title={t('workspace.addons')}>
              <ul className="flex flex-col gap-2">{l.addons.map((a: any) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span>{pick(a.name_ar, a.name_en)} · <span dir="ltr">{money(a.unit_price_minor)}</span></span>
                  <Input type="number" min={0} max={a.max_quantity} className="w-20" aria-label={t('workspace.quantity')} value={qty[a.id] ?? 0} onChange={(e) => { setPriced(null); setQty({ ...qty, [a.id]: Math.max(0, Math.min(a.max_quantity, Number(e.target.value) || 0)) }); }} />
                </li>))}</ul>
            </Card>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('workspace.start')}>{(p) => <Input {...p} type="time" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
            <Button variant="outline" onClick={() => price.mutate()}>{t('workspace.total_with_addons')}</Button>
          </div>
          {l.free.map((w: { start: string; end: string }, i: number) => <p key={i} className="text-xs"><CalendarClock className="inline size-3.5" aria-hidden /> {when(w.start)} → {when(w.end)}</p>)}
          {priced ? <PriceBreakdown q={priced} /> : null}
          {book.error ? <FormErrorSummary message={msg(book.error)} /> : null}
          <div><Button loading={book.isPending} disabled={!start || !date} onClick={() => book.mutate()}>{t('workspace.request')}</Button></div>
        </div>
      ) : null}
    </Drawer>
  );
}

type Priced = { lines: Array<{ kind: string; amount_minor: number; quantity: number; description: string }>; rent_minor: number; addons_minor: number; discount_minor: number; tax_minor: number; total_minor: number; base_total_minor: number; tax: { rate_bp: number; prices_include_tax: boolean; label?: string | null } };

/** LUMA-AUDIT-037: the full price before booking — rent, add-ons, the add-ons discount, tax (included or added) and the total due. */
function PriceBreakdown({ q }: { q: Priced }) {
  const { t } = useI18n();
  const { money } = useFmt();
  const sum = (k: string) => q.lines.filter((l) => l.kind === k).reduce((a, l) => a + l.amount_minor, 0);
  const pct = q.addons_minor > 0 ? Math.round((q.discount_minor / q.addons_minor) * 1000) / 10 : 0;
  const label = q.tax.label || t('hosting.statement.tax');
  const rows: Array<[string, number, boolean?]> = [
    [t('workspace.breakdown.rent'), q.rent_minor],
    ...(sum('product') ? [[t('workspace.breakdown.products'), sum('product')] as [string, number]] : []),
    ...(sum('equipment') ? [[t('workspace.breakdown.equipment'), sum('equipment')] as [string, number]] : []),
    ...(q.discount_minor ? [[t('workspace.breakdown.discount', { pct }), -q.discount_minor] as [string, number]] : []),
    ...(q.tax_minor && !q.tax.prices_include_tax ? [[t('workspace.breakdown.subtotal'), q.rent_minor + q.addons_minor - q.discount_minor] as [string, number], [t('workspace.breakdown.tax_added', { label, rate: q.tax.rate_bp / 100 }), q.tax_minor] as [string, number]] : []),
    [t('workspace.breakdown.total'), q.total_minor, true],
    ...(q.tax_minor && q.tax.prices_include_tax ? [[t('workspace.breakdown.tax_included', { label, rate: q.tax.rate_bp / 100 }), q.tax_minor] as [string, number]] : []),
  ];
  return (
    <Card title={t('workspace.breakdown.title')}>
      <table className="w-full text-sm" data-testid="price-breakdown"><tbody>
        {rows.map(([k, v, strong]) => (
          <tr key={k} className="border-b border-line last:border-0">
            <th scope="row" className={`py-1.5 text-start ${strong ? 'font-semibold' : 'font-normal text-ink-muted'}`}>{k}</th>
            <td className={`py-1.5 text-end ${strong ? 'font-semibold' : ''}`} dir="ltr">{money(v)}</td>
          </tr>))}
      </tbody></table>
      <p className="mt-2 text-xs text-ink-muted">{t('workspace.price_label_base')}: <span dir="ltr">{money(q.base_total_minor)}</span> · {t(q.tax.prices_include_tax ? 'workspace.tax_basis_inclusive' : 'workspace.tax_basis_exclusive')}</p>
    </Card>
  );
}

function MyBookings({ rows, onOpen }: { rows: Row[]; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const { money, when } = useFmt();
  if (!rows.length) return <EmptyState title={t('hosting.empty.bookings')} />;
  return (
    <ul className="grid gap-3 md:grid-cols-2">{rows.map((r) => (
      <li key={r.id}><button type="button" onClick={() => onOpen(r.id)} className="flex w-full flex-col gap-1 rounded-2xl border border-line bg-white p-4 text-start hover:border-luma-300 focus-visible:outline-2">
        <div className="flex justify-between gap-2"><p className="font-semibold">{r.host.name} · {r.space_code}</p><Badge tone={TONE[r.status] ?? 'neutral'}>{t(`hosting.status.${r.status}`)}</Badge></div>
        <p className="text-sm">{when(r.starts_at)} → {when(r.ends_at)}</p>
        <p className="text-sm"><span dir="ltr">{money(r.total_minor)}</span> <span dir="ltr" className="ms-2 text-xs text-ink-muted">{r.number}</span></p>
      </button></li>))}</ul>
  );
}

function BookingDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, locale, pick } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const q = useApiQuery<any>(['ws-booking', access.slug, id], access.api(`/workspace/bookings/${id}`));
  const [code, setCode] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [mat, setMat] = useState({ addon_id: '', quantity: 1 });
  const [rev, setRev] = useState({ rating: 5, body: '' });
  const done = async () => { await q.refetch(); onChanged(); toast({ tone: 'ok', text: t('hosting.done') }); };
  const act = useApiMutation<{ path: string; body?: unknown }, unknown>((v) => api(access.api(`/workspace/bookings/${id}${v.path}`), { body: v.body ?? {} }), { onSuccess: done });
  const pay = useApiMutation<'checkout' | 'pay-dues', { payment: { checkout_url: string } }>((path, ctx) => api(access.api(`/workspace/bookings/${id}/${path}`), { body: {}, idempotencyKey: ctx.idempotencyKey }), {
    onSuccess: (r) => { toast({ tone: 'info', text: t('workspace.paying') }); window.location.assign(r.payment.checkout_url); },
  });
  const b = q.data;
  const catalog = useApiQuery<any>(['ws-listing-addons', b?.listing_id], b?.can?.request_material ? access.api(`/workspace/listings/${b.listing_id}`) : null);
  const token: string | null = b?.qr_token ?? null;
  const qrTitle = t('workspace.qr');
  const qr = useMemo(() => (token ? qrSvg(encodeQr(token, { ecc: 'M' }), { margin: 2, title: qrTitle }) : null), [token, qrTitle]);
  const st = b?.statement as Statement | undefined;
  return (
    <Drawer open wide onClose={onClose} title={b ? `${b.number} · ${b.host?.name ?? ''}` : t('states.loading')}>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} /> : b && st ? (
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={TONE[b.status] ?? 'neutral'}>{t(`hosting.status.${b.status}`)}</Badge>
            {b.hold_expires_at && ['pending_approval', 'held', 'pending_payment'].includes(b.status) ? <span className="text-xs font-medium text-warn" data-testid="hold-expiry">{t(b.status === 'pending_approval' ? 'workspace.approval_until' : 'workspace.hold_until', { when: when(b.hold_expires_at) })}</span> : null}</div>
          <p>{b.host.branch_name}{b.host.address ? ` — ${b.host.address}` : ''} · {when(b.starts_at)} → {when(b.ends_at)}</p>
          {!b.location_confirmed ? <Alert tone="warn">{t('workspace.location_pending')}</Alert> : null}
          {b.access_instructions ? <Card title={t('workspace.access_instructions')}><p className="whitespace-pre-line">{locale === 'ar' ? (b.access_instructions.ar ?? b.access_instructions.en) : (b.access_instructions.en ?? b.access_instructions.ar)}</p></Card> : null}
          {qr ? <Card title={t('workspace.qr')}><div className="mx-auto size-44" dangerouslySetInnerHTML={{ __html: qr }} /><p className="mt-1 break-all text-center text-xs" dir="ltr">{b.qr_token}</p></Card> : null}
          {act.error || pay.error ? <FormErrorSummary message={msg(act.error ?? pay.error)} /> : null}
          <div className="flex flex-wrap gap-2">
            {b.can.pay ? <Button loading={pay.isPending} onClick={() => pay.mutate('checkout')}>{t('workspace.pay')}</Button> : null}
            {st.due_from_guest_minor > 0 && !b.can.pay && b.status !== 'pending_payment' ? <Button loading={pay.isPending} onClick={() => pay.mutate('pay-dues')}>{t('workspace.pay_dues')} <span dir="ltr">{money(st.due_from_guest_minor)}</span></Button> : null}
            {b.can.cancel ? <Button variant="outline" onClick={() => setCancelOpen(true)}>{t('workspace.cancel')}</Button> : null}
          </div>
          {b.can.check_in || b.can.check_out ? (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); act.mutate({ path: '/check', body: { action: b.can.check_in ? 'in' : 'out', code } }); }}>
              <Field label={t('workspace.code_entry')}>{(p) => <Input {...p} dir="ltr" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}</Field>
              <Button type="submit" disabled={code.length !== 6}>{t(b.can.check_in ? 'workspace.check_in' : 'workspace.check_out')}</Button>
            </form>
          ) : null}
          <Card title={t('hosting.settlement')}><StatementTable s={st} as="guest" /></Card>
          {b.invoices.length ? <p>{t('workspace.invoice')}: {b.invoices.map((i: any) => <span key={i.id} dir="ltr" className="ms-2">{i.number}</span>)}</p> : null}
          <Card title={t('workspace.linked')}>
            {b.linked_appointments.length ? <ul className="flex flex-col gap-1" data-testid="linked-appointments">{b.linked_appointments.map((a: any) => <li key={a.id}><span dir="ltr">{a.number}</span> · {when(a.starts_at)} → {when(a.ends_at)} · <Badge tone={TONE[a.status] ?? 'neutral'}>{t(`workspace.appt_status.${a.status}`)}</Badge></li>)}</ul>
              : <p className="text-ink-muted">{b.can.add_appointment ? t('workspace.add_appointment_here') : t('workspace.add_appointment_after_confirm')}</p>}
            {b.can.add_appointment ? <AddAppointment space={b} onAdded={async () => { await q.refetch(); onChanged(); }} /> : null}
            <p className="mt-2 text-xs text-ink-muted">{t('workspace.cancel_note')}</p>
          </Card>
          {b.can.request_material && catalog.data?.addons?.length ? (
            <Card title={t('workspace.request_material')}>
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (mat.addon_id) act.mutate({ path: '/materials', body: mat }); }}>
                <Field label={t('workspace.addons')}>{(p) => <Select {...p} value={mat.addon_id} onChange={(e) => setMat({ ...mat, addon_id: e.target.value })}>
                  <option value="">—</option>{catalog.data.addons.map((a: any) => <option key={a.id} value={a.id}>{pick(a.name_ar, a.name_en)} · {money(a.unit_price_minor)}</option>)}</Select>}</Field>
                <Field label={t('workspace.quantity')}>{(p) => <Input {...p} type="number" min={1} value={mat.quantity} onChange={(e) => setMat({ ...mat, quantity: Math.max(1, Number(e.target.value) || 1) })} />}</Field>
                <Button type="submit" variant="outline">{t('workspace.send')}</Button>
              </form>
            </Card>
          ) : null}
          {b.can.review ? (
            <Card title={t('workspace.rate')}>
              <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); act.mutate({ path: '/review', body: { rating: rev.rating, body: rev.body || undefined } }); }}>
                <Field label={t('workspace.rating_label')}>{(p) => <Select {...p} value={rev.rating} onChange={(e) => setRev({ ...rev, rating: Number(e.target.value) })}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>
                <Field label={t('workspace.comment')}>{(p) => <Textarea {...p} maxLength={1000} value={rev.body} onChange={(e) => setRev({ ...rev, body: e.target.value })} />}</Field>
                <div><Button type="submit">{t('workspace.send')}</Button></div>
              </form>
            </Card>
          ) : null}
          <ReasonDialog open={cancelOpen} onClose={() => setCancelOpen(false)} title={t('workspace.cancel')} body={t('workspace.cancel_note')}
            onConfirm={async (reason: string) => { await act.mutateAsync({ path: '/cancel', body: { reason } }); setCancelOpen(false); }} />
        </div>
      ) : null}
    </Drawer>
  );
}

type Svc = { id: string; name_ar: string | null; name_en: string | null; duration_min: number; buffer_before_min: number; buffer_after_min: number; is_active: boolean; archived_at: string | null; staff: Array<{ staff_id: string; duration_override_min: number | null }> };
type Cust = { id: string; display_name: string; phone: string | null };

/** Wall-clock HH:MM on a date in the space's time zone → ISO with that zone's offset (the server validates everything). */
function zonedIso(dateISO: string, hhmm: string, tz: string) {
  const local = `${dateISO}T${hhmm}:00`;
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(`${local}Z`)).find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '';
  return `${local}${offset === '' ? '+00:00' : offset}`;
}
function zonedParts(iso: string, tz: string) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? '';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}

/**
 * Requirement 13 / journey 1: place one of her client appointments inside this
 * confirmed space booking. The appointment stays in her own business (D3, D14);
 * the salon never sees it. The service's own preparation/cleanup buffers must
 * also fit inside the space time.
 */
function AddAppointment({ space, onAdded }: { space: any; onAdded: () => Promise<void> }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { when } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const tz = space.timezone as string;
  const day = zonedParts(space.starts_at, tz).date;
  const services = useApiQuery<Svc[]>(['services', access.slug, ''], access.api('/services'));
  const customers = useApiQuery<{ items: Cust[] }>(['customers', access.slug, 'ws-pick'], access.can('customers.view') ? access.api('/customers?limit=100&sort=name') : null);
  const mine = (services.data ?? []).filter((s) => s.is_active && !s.archived_at && s.staff.some((x) => x.staff_id === space.guest_staff_id));
  const [f, setF] = useState({ customer_id: '', service_id: '', start: zonedParts(space.starts_at, tz).time });
  const svc = mine.find((s) => s.id === f.service_id) ?? null;
  const add = useApiMutation<void, { confirmed?: boolean; notice?: string }>((_, ctx) => api(access.api(`/workspace/bookings/${space.id}/appointments`), {
    idempotencyKey: ctx.idempotencyKey,
    body: { customer_id: f.customer_id, mode: 'confirm_on_site', items: [{ key: 'a', service_id: f.service_id, staff_id: space.guest_staff_id, start: zonedIso(day, f.start, tz) }] },
  }), { onSuccess: async (r) => { toast({ tone: 'ok', text: t(r.notice === 'prepayment_required' ? 'workspace.appt_added_prepay' : 'workspace.appt_added') }); setF({ ...f, customer_id: '' }); await onAdded(); } });
  const err = add.error as { code?: string } | null;
  if (services.isLoading || customers.isLoading) return <LoadingState rows={2} />;
  if (services.error || customers.error) return <ErrorState error={services.error ?? customers.error} onRetry={() => { services.refetch(); customers.refetch(); }} />;
  if (!mine.length) return <Alert tone="info" className="mt-2">{t('workspace.appt_no_services')}</Alert>;
  if (!customers.data?.items.length) return <Alert tone="info" className="mt-2">{t('workspace.appt_no_customers')} <Link className="font-medium underline" href={`/app/${access.slug}/customers`}>{t('workspace.appt_go_customers')}</Link></Alert>;
  return (
    <form className="mt-3 flex flex-col gap-2 rounded-xl border border-line p-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }} aria-label={t('workspace.appt_add')}>
      <p className="font-medium">{t('workspace.appt_add')}</p>
      <p className="text-xs text-ink-muted">{t('workspace.appt_window', { from: when(space.starts_at), to: when(space.ends_at) })}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label={t('workspace.appt_customer')} required>{(p) => <Select {...p} value={f.customer_id} onChange={(e) => setF({ ...f, customer_id: e.target.value })} required>
          <option value="">—</option>{customers.data.items.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</Select>}</Field>
        <Field label={t('workspace.appt_service')} required>{(p) => <Select {...p} value={f.service_id} onChange={(e) => setF({ ...f, service_id: e.target.value })} required>
          <option value="">—</option>{mine.map((s) => <option key={s.id} value={s.id}>{pick(s.name_ar, s.name_en)}</option>)}</Select>}</Field>
        <Field label={t('workspace.appt_start')} required>{(p) => <Input {...p} type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} required />}</Field>
      </div>
      {svc ? <p className="text-xs text-ink-muted">{t('workspace.appt_needs', { dur: svc.duration_min, before: svc.buffer_before_min, after: svc.buffer_after_min })}</p> : null}
      {add.error ? (err?.code === 'outside_workspace_window'
        ? <Alert tone="danger" title={t('errors.outside_workspace_window')}>{t('workspace.appt_outside_detail', { from: when(space.starts_at), to: when(space.ends_at), before: svc?.buffer_before_min ?? 0, after: svc?.buffer_after_min ?? 0 })}</Alert>
        : <FormErrorSummary message={msg(add.error)} />) : null}
      <div><Button type="submit" variant="outline" loading={add.isPending} disabled={!f.customer_id || !f.service_id || !f.start}>{t('workspace.appt_add')}</Button></div>
    </form>
  );
}

function Expenses() {
  const { t } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const q = useApiQuery<any>(['ws-summary', access.slug], access.api('/workspace/summary'));
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={t('workspace.expenses.total')} value={<span dir="ltr">{money(q.data.hosting_expense_minor)}</span>} />
        <Stat label={t('workspace.expenses.dues')} value={<span dir="ltr">{money(q.data.dues_minor)}</span>} tone={q.data.dues_minor > 0 ? 'warn' : undefined} />
      </div>
      <Card title={t('workspace.expenses.per_host')}>
        {q.data.per_host.length ? <ul data-testid="expense-per-host">{q.data.per_host.map((h: any) => <li key={h.host} className="flex justify-between gap-2"><span>{h.host} ({h.count})</span><span dir="ltr">{money(h.total_minor)}</span></li>)}</ul>
          : <p className="text-ink-muted">{t('workspace.expenses.none')}</p>}
      </Card>
      <p className="text-xs text-ink-muted">{t('workspace.expenses.basis')}</p>
    </div>
  );
}
