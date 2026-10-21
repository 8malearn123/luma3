'use client';

import { useState } from 'react';
import { Plus, Search, Trash2, UserPlus } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useDebounced, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Checkbox, Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Alert, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Drawer } from '../components/overlay';
import { cx } from '../components/cx';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useBookingFmt, useBranches } from './common';
import { SlotPicker, type RequestedItem, type SlotOption } from './SlotPicker';

type Service = {
  id: string; name_ar: string | null; name_en: string | null; is_active: boolean; is_visible: boolean; bookable_internally_when_hidden: boolean; booking_mode: string; branch_id: string | null;
  price_minor: number; duration_min: number;
  staff: Array<{ staff_id: string; display_name: string; is_active: boolean }>;
  variants: Array<{ id: string; name_ar: string | null; name_en: string | null; is_active: boolean }>;
  addons: Array<{ id: string; name_ar: string | null; name_en: string | null; is_active: boolean; price_minor: number }>;
};
type Customer = { id: string; display_name: string; phone: string | null; email: string | null; has_account: boolean };
type Line = { key: string; service_id: string; variant_id: string; staff_id: string; addon_ids: string[] };
type Created = { booking_id: string; number: string; status: string; confirmed?: boolean; notice?: string; requires_manual_approval?: boolean };

let seq = 0;
const newLine = (): Line => ({ key: `l${++seq}`, service_id: '', variant_id: '', staff_id: '', addon_ids: [] });

/** Walk-in / phone booking created by reception (POST /bookings, source "dashboard"). */
export function NewBookingDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const { money } = useBookingFmt();
  const services = useApiQuery<Service[]>(['services', access.slug], access.api('/services'));
  const branches = useBranches();
  const activeBranches = (branches.data?.items ?? []).filter((b) => b.status === 'active');
  const [branchId, setBranchId] = useState('');
  const branch = activeBranches.find((b) => b.id === branchId) ?? activeBranches.find((b) => b.is_primary) ?? activeBranches[0];
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [slot, setSlot] = useState<SlotOption | null>(null);
  const [customerNote, setCustomerNote] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [mode, setMode] = useState<'confirm_on_site' | 'hold_only'>('confirm_on_site');
  const [notice, setNotice] = useState<Created | null>(null);
  const dirty = !!customer || lines.some((l) => l.service_id) || !!customerNote || !!internalNote;
  useUnsavedChangesWarning(dirty && !notice);

  const bookable = (services.data ?? []).filter((s) => s.is_active && s.booking_mode === 'individual' && (s.is_visible || s.bookable_internally_when_hidden)
    && (!s.branch_id || !branch || s.branch_id === branch.id));
  const complete = lines.filter((l) => l.service_id);
  const items: RequestedItem[] = complete.map((l) => ({ key: l.key, service_id: l.service_id, variant_id: l.variant_id || null, addon_ids: l.addon_ids, staff_id: l.staff_id || null }));
  const update = (key: string, patch: Partial<Line>) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))); setSlot(null); };

  const create = useApiMutation((_: void, { idempotencyKey }) => api<Created>(access.api('/bookings'), {
    idempotencyKey,
    body: {
      branch_id: branch?.id ?? null, customer_id: customer!.id, mode,
      items: items.map((i) => { const s = slot!.items.find((x) => x.key === i.key)!; return { ...i, staff_id: s.staff_id, start: s.start }; }),
      ...(customerNote.trim() ? { customer_note: customerNote.trim() } : {}), ...(internalNote.trim() ? { internal_note: internalNote.trim() } : {}),
    },
  }), {
    invalidate: [['bookings', access.slug]],
    onSuccess: (r) => {
      if (r.notice === 'prepayment_required') { setNotice(r); return; }
      toast({ tone: 'ok', text: t('bookings_ui.new.created', { number: r.number }) });
      onCreated(r.booking_id);
    },
  });
  const submit = () => create.mutate(undefined, { onError: (e) => { if (e instanceof ApiError && (e.code === 'slot_unavailable' || e.code === 'hold_expired')) setSlot(null); } });

  return (
    <Drawer open onClose={onClose} wide title={t('booking.dashboard.new')}
      footer={notice ? <Button onClick={() => onCreated(notice.booking_id)}>{t('bookings_ui.new.open_booking')}</Button> : <>
        <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
        <Button loading={create.isPending} disabled={!customer || !slot || !items.length} onClick={submit}>{mode === 'confirm_on_site' ? t('booking.dashboard.confirm_on_site') : t('booking.dashboard.hold_only')}</Button>
      </>}>
      {notice ? (
        <Alert tone="warn" title={t('bookings_ui.new.created', { number: notice.number })}>{t('booking.dashboard.prepayment_required')}</Alert>
      ) : (
        <div className="flex flex-col gap-6">
          <FormErrorSummary message={create.error ? msg(create.error) : null} />
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">1. {t('booking.dashboard.customer')}</h3>
            {customer ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-luma-300 bg-luma-50 p-3">
                <div className="min-w-0"><p className="font-medium">{customer.display_name}</p><p className="truncate text-xs text-ink-muted" dir="ltr">{[customer.phone, customer.email].filter(Boolean).join(' · ')}</p></div>
                <Button size="sm" variant="ghost" onClick={() => setCustomer(null)}>{t('bookings_ui.new.change')}</Button>
              </div>
            ) : <CustomerPicker onPick={setCustomer} />}
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">2. {t('booking.dashboard.services')}</h3>
            {activeBranches.length > 1 ? (
              <Field label={t('fields.branch')}>{(p) => (
                <Select {...p} value={branch?.id ?? ''} onChange={(e) => { setBranchId(e.target.value); setSlot(null); }}>
                  {activeBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              )}</Field>
            ) : null}
            {services.isLoading ? <LoadingState rows={2} /> : services.error ? <ErrorState error={services.error} onRetry={() => services.refetch()} /> : !bookable.length ? (
              <EmptyState title={t('bookings_ui.new.no_services')} />
            ) : (
              <>
                {lines.map((l, idx) => {
                  const svc = bookable.find((s) => s.id === l.service_id);
                  const staff = (svc?.staff ?? []).filter((s) => s.is_active);
                  const variants = (svc?.variants ?? []).filter((v) => v.is_active);
                  const addons = (svc?.addons ?? []).filter((a) => a.is_active);
                  return (
                    <div key={l.key} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                      <div className="flex items-end gap-2">
                        <Field className="flex-1" label={t('bookings_ui.new.service_n', { n: idx + 1 })}>{(p) => (
                          <Select {...p} value={l.service_id} onChange={(e) => update(l.key, { service_id: e.target.value, variant_id: '', staff_id: '', addon_ids: [] })}>
                            <option value="">{t('booking.flow.choose_service')}</option>
                            {bookable.map((s) => <option key={s.id} value={s.id}>{pick(s.name_ar, s.name_en)}</option>)}
                          </Select>
                        )}</Field>
                        {lines.length > 1 ? <IconButton label={t('booking.flow.remove_service')} onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); setSlot(null); }}><Trash2 className="size-4" /></IconButton> : null}
                      </div>
                      {svc ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                          {variants.length ? (
                            <Field label={t('bookings_ui.new.variant')}>{(p) => (
                              <Select {...p} value={l.variant_id} onChange={(e) => update(l.key, { variant_id: e.target.value })}>
                                <option value="">{t('bookings_ui.new.base_variant')}</option>
                                {variants.map((v) => <option key={v.id} value={v.id}>{pick(v.name_ar, v.name_en)}</option>)}
                              </Select>
                            )}</Field>
                          ) : null}
                          <Field label={t('booking.dashboard.staff')}>{(p) => (
                            <Select {...p} value={l.staff_id} onChange={(e) => update(l.key, { staff_id: e.target.value })}>
                              <option value="">{t('booking.flow.any_staff')}</option>
                              {staff.map((s) => <option key={s.staff_id} value={s.staff_id}>{s.display_name}</option>)}
                            </Select>
                          )}</Field>
                          {addons.length ? (
                            <fieldset className="flex flex-col gap-1 sm:col-span-2">
                              <legend className="mb-1 text-sm font-medium">{t('bookings_ui.new.addons')}</legend>
                              {addons.map((a) => (
                                <Checkbox key={a.id} label={<>{pick(a.name_ar, a.name_en)} <span dir="ltr" className="text-ink-muted">+{money(a.price_minor)}</span></>} checked={l.addon_ids.includes(a.id)}
                                  onChange={(v) => update(l.key, { addon_ids: v ? [...l.addon_ids, a.id] : l.addon_ids.filter((x) => x !== a.id) })} />
                              ))}
                            </fieldset>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {lines.length < 6 ? <Button variant="outline" size="sm" className="self-start" icon={<Plus className="size-4" />} onClick={() => setLines((ls) => [...ls, newLine()])}>{t('booking.flow.add_service')}</Button> : null}
              </>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">3. {t('booking.flow.choose_time')}</h3>
            <SlotPicker branchId={branch?.id} items={items} timezone={branch?.timezone ?? access.timezone} value={slot} onChange={setSlot} showPrices />
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">4. {t('bookings_ui.new.details')}</h3>
            <Field label={t('booking.dashboard.customer_note')}>{(p) => <Textarea {...p} rows={2} maxLength={500} value={customerNote} onChange={(e) => setCustomerNote(e.target.value)} />}</Field>
            <Field label={t('booking.dashboard.internal_note')} hint={t('bookings_ui.new.internal_hint')}>{(p) => <Textarea {...p} rows={2} maxLength={1000} value={internalNote} onChange={(e) => setInternalNote(e.target.value)} />}</Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t('bookings_ui.new.payment_mode')}</legend>
              {(['confirm_on_site', 'hold_only'] as const).map((m) => (
                <label key={m} className={cx('flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm', mode === m ? 'border-luma-700 bg-luma-50' : 'border-line')}>
                  <input type="radio" name="mode" className="mt-0.5 accent-luma-700" checked={mode === m} onChange={() => setMode(m)} />
                  <span><span className="font-medium">{t(`booking.dashboard.${m}`)}</span><span className="block text-xs text-ink-muted">{t(`bookings_ui.new.${m}_hint`)}</span></span>
                </label>
              ))}
            </fieldset>
          </section>
        </div>
      )}
    </Drawer>
  );
}

function CustomerPicker({ onPick }: { onPick: (c: Customer) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const canSearch = access.can('customers.view');
  const canCreate = access.can('customers.manage') && !access.readOnly;
  const list = useApiQuery<{ items: Customer[] }>(['customers', access.slug, 'pick', q], canSearch && q.length >= 2 ? access.api(`/customers?q=${encodeURIComponent(q)}&limit=8`) : null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const create = useApiMutation((_: void, { idempotencyKey }) => api<Customer>(access.api('/customers'), { idempotencyKey, body: { display_name: name.trim(), phone: phone.trim() || null, source: 'walk_in' } }), {
    invalidate: [['customers', access.slug]], onSuccess: (c) => onPick(c),
  });
  if (!canSearch && !canCreate) return <Alert tone="warn">{t('bookings_ui.new.no_customer_access')}</Alert>;
  return (
    <div className="flex flex-col gap-2">
      {canSearch ? (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-muted" aria-hidden />
            <Input aria-label={t('booking.dashboard.select_customer')} placeholder={t('bookings_ui.new.customer_search')} className="ps-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {q.length >= 2 ? (list.isLoading ? <LoadingState rows={2} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.items.length ? (
            <p className="text-sm text-ink-muted">{t('bookings_ui.new.no_customers')}</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {list.data.items.map((c) => (
                <li key={c.id}><button type="button" className="flex w-full flex-col items-start px-3 py-2 text-start text-sm hover:bg-luma-50" onClick={() => onPick(c)}>
                  <span className="font-medium">{c.display_name}</span>
                  <span className="text-xs text-ink-muted" dir="ltr">{[c.phone, c.email].filter(Boolean).join(' · ')}</span>
                </button></li>
              ))}
            </ul>
          )) : null}
        </>
      ) : null}
      {canCreate ? (creating ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
          <p className="text-sm font-medium">{t('booking.dashboard.new_customer')}</p>
          <FormErrorSummary message={create.error ? msg(create.error) : null} />
          <Field label={t('booking.dashboard.customer_name')} required>{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={t('booking.dashboard.customer_phone')} hint={t('bookings_ui.new.phone_hint')}>{(p) => <Input {...p} dir="ltr" inputMode="tel" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} />}</Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>{t('actions.cancel')}</Button>
            <Button size="sm" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>{t('bookings_ui.new.add_customer')}</Button>
          </div>
        </div>
      ) : <Button variant="outline" size="sm" className="self-start" icon={<UserPlus className="size-4" />} onClick={() => { setCreating(true); setName(search.trim()); }}>{t('booking.dashboard.new_customer')}</Button>) : null}
    </div>
  );
}
