'use client';

import { useMemo, useState } from 'react';
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
              <p className="text-sm">{t('workspace.base_price')}: <span dir="ltr">{money(r.price_minor)}</span> {t(`workspace.per.${r.price_model}`)} · <span dir="ltr">{money(r.base_total_minor)}</span></p>
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
  const [priced, setPriced] = useState<any>(null);
  const price = useApiMutation<void, any>(() => api(access.api('/workspace/quote'), { body: { listing_id: id, duration_min: duration, addons } }), { onSuccess: (r) => setPriced(r) });
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
                  <Input type="number" min={0} max={a.max_quantity} className="w-20" aria-label={t('workspace.quantity')} value={qty[a.id] ?? 0} onChange={(e) => setQty({ ...qty, [a.id]: Math.max(0, Math.min(a.max_quantity, Number(e.target.value) || 0)) })} />
                </li>))}</ul>
            </Card>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('workspace.start')}>{(p) => <Input {...p} type="time" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
            <Button variant="outline" onClick={() => price.mutate()}>{t('workspace.total_with_addons')}</Button>
          </div>
          {l.free.map((w: { start: string; end: string }, i: number) => <p key={i} className="text-xs"><CalendarClock className="inline size-3.5" aria-hidden /> {when(w.start)} → {when(w.end)}</p>)}
          {priced ? <Card><p>{t('workspace.base_price')}: <span dir="ltr">{money(priced.base_total_minor)}</span></p><p className="font-semibold">{t('workspace.total_with_addons')}: <span dir="ltr">{money(priced.total_minor)}</span></p></Card> : null}
          {book.error ? <FormErrorSummary message={msg(book.error)} /> : null}
          <div><Button loading={book.isPending} disabled={!start || !date} onClick={() => book.mutate()}>{t('workspace.request')}</Button></div>
        </div>
      ) : null}
    </Drawer>
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
          <div className="flex items-center gap-2"><Badge tone={TONE[b.status] ?? 'neutral'}>{t(`hosting.status.${b.status}`)}</Badge>{b.hold_expires_at ? <span className="text-xs text-amber-700">{when(b.hold_expires_at)}</span> : null}</div>
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
            {b.linked_appointments.length ? <ul>{b.linked_appointments.map((a: any) => <li key={a.id}><span dir="ltr">{a.number}</span> · {when(a.starts_at)} · {a.status}</li>)}</ul> : <p className="text-ink-muted">{t('workspace.add_appointment')}</p>}
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
        <ul>{q.data.per_host.map((h: any) => <li key={h.host} className="flex justify-between"><span>{h.host} ({h.count})</span><span dir="ltr">{money(h.total_minor)}</span></li>)}</ul>
      </Card>
    </div>
  );
}
