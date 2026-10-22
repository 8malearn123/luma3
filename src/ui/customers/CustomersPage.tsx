'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Archive, ArchiveRestore, Contact, Plus, Search, Star, UserCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDate, formatDateTime, formatMoney } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiQuery, useDebounced, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Card, DataTable, PageHeader, Pager, Tabs, type Column } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { ActionBadge } from '../policy/labels';
import { ReviewsPanel } from './ReviewsPanel';
import { useCursorStack } from '../policy/paging';

type CustomerRow = { id: string; display_name: string; phone: string | null; email: string | null; tags: string[]; source: string; status: string; last_visit_at: string | null; has_account: boolean; version: number };
type Paged<T> = { items: T[]; next_cursor: string | null };
type Consent = { granted: boolean; recorded_at: string | null; source: string | null };
type Detail = CustomerRow & {
  private_notes?: string | null; preferences: { preferred_contact?: string; language?: string; note?: string }; first_visit_at: string | null; created_at: string;
  bookings: Array<{ id: string; number: string; status: string; starts_at: string; timezone: string; total_minor?: number; currency: string }>;
  orders: Array<{ id: string; number: string; status: string; total_minor: number; currency: string; created_at: string }>;
  reviews: Array<{ id: string; rating: number; comment: string | null; status: string; created_at: string }>;
  consents: Record<string, Record<string, Consent>>;
  decisions: Array<{ id: string; action: string; status: string; effective_at: string; expires_at: string | null; reason?: string }>;
  incidents?: Array<{ id: string; type: string; status: string; occurred_at: string }>;
};

export function CustomersPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'customers' | 'reviews'>('customers');
  return (
    <div>
      <PageHeader title={t('customers.title')} subtitle={t('customers.subtitle')} />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'customers', label: t('customers.tabs.customers') }, { value: 'reviews', label: t('customers.tabs.reviews') }]} />
      {tab === 'customers' ? <CustomerList /> : <ReviewsPanel />}
    </div>
  );
}

function CustomerList() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [status, setStatus] = useState('active');
  const [source, setSource] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState('recent');
  const pager = useCursorStack([dq, status, source, tag, sort].join('|'));
  const search = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(() => search.get('customer'));
  const [creating, setCreating] = useState(false);

  const params = new URLSearchParams({ status, sort, limit: '25' });
  if (dq) params.set('q', dq);
  if (source) params.set('source', source);
  if (tag) params.set('tag', tag);
  if (pager.cursor) params.set('cursor', pager.cursor);
  const list = useApiQuery<Paged<CustomerRow>>(['customers', access.slug, params.toString()], access.api(`/customers?${params}`));
  const tags = useApiQuery<Array<{ tag: string; n: number }>>(['customer-tags', access.slug], access.api('/customers/tags'));

  const columns: Column<CustomerRow>[] = [
    { key: 'name', header: t('customers.cols.name'), cell: (r) => (
      <div className="flex items-center gap-2">
        <span className="font-medium">{r.display_name}</span>
        {r.has_account ? <UserCheck className="size-4 text-luma-500" aria-label={t('customers.has_account')} /> : null}
        {r.status === 'archived' ? <Badge>{t('customers.status.archived')}</Badge> : null}
      </div>
    ) },
    { key: 'contact', header: t('customers.cols.contact'), cell: (r) => <span dir="ltr" className="text-ink-muted">{r.phone ?? r.email ?? '—'}</span> },
    { key: 'tags', header: t('customers.cols.tags'), className: 'hidden md:table-cell', cell: (r) => <div className="flex flex-wrap gap-1">{r.tags.map((x) => <Badge key={x}>{x}</Badge>)}</div> },
    { key: 'last_visit', header: t('customers.cols.last_visit'), className: 'hidden sm:table-cell', cell: (r) => (r.last_visit_at ? formatDate(r.last_visit_at, { locale, tz: access.timezone }) : '—') },
    { key: 'source', header: t('customers.cols.source'), className: 'hidden lg:table-cell', cell: (r) => t(`customers.source.${r.source}`) },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-56 flex-1">
          <label htmlFor="cust-search" className="sr-only">{t('customers.search_label')}</label>
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" aria-hidden />
          <Input id="cust-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('customers.search')} className="ps-9" />
        </div>
        <LabelledSelect label={t('fields.status')} value={status} onChange={setStatus} options={['active', 'archived', 'all'].map((v) => [v, t(`customers.status.${v}`)])} />
        <LabelledSelect label={t('customers.source.label')} value={source} onChange={setSource} options={[['', t('customers.source.any')], ...['storefront', 'dashboard', 'walk_in', 'import'].map((v) => [v, t(`customers.source.${v}`)] as [string, string])]} />
        <LabelledSelect label={t('customers.tag_filter')} value={tag} onChange={setTag} options={[['', t('customers.any_tag')], ...(tags.data ?? []).map((x) => [x.tag, `${x.tag} (${x.n})`] as [string, string])]} />
        <LabelledSelect label={t('customers.sort.label')} value={sort} onChange={setSort} options={['recent', 'name', 'last_visit', 'created'].map((v) => [v, t(`customers.sort.${v}`)])} />
        {access.can('customers.manage') && !access.readOnly ? <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('customers.new')}</Button> : null}
      </div>
      {list.isLoading ? <LoadingState rows={5} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.items.length ? (
        <EmptyState icon={<Contact className="size-8" aria-hidden />} title={dq || source || tag ? t('customers.no_results') : t('customers.empty')} hint={dq ? undefined : t('customers.empty_hint')} />
      ) : (
        <>
          <DataTable rows={list.data.items} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id)} caption={t('customers.title')} />
          <Pager hasPrev={pager.hasPrev} hasNext={!!list.data.next_cursor} onPrev={pager.prev} onNext={() => pager.next(list.data!.next_cursor!)} />
        </>
      )}
      {openId ? <CustomerDrawer id={openId} onClose={() => setOpenId(null)} /> : null}
      <CreateCustomerDrawer open={creating} onClose={() => setCreating(false)} onOpenExisting={(id) => { setCreating(false); setOpenId(id); }} />
    </div>
  );
}

function LabelledSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <Field label={label} className="min-w-36">
      {(p) => <Select {...p} value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
    </Field>
  );
}

function parseTags(s: string) {
  return [...new Set(s.split(/[,،]/).map((x) => x.trim()).filter(Boolean))].slice(0, 20);
}

function CreateCustomerDrawer({ open, onClose, onOpenExisting }: { open: boolean; onClose: () => void; onOpenExisting: (id: string) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ display_name: '', phone: '', email: '', tags: '', private_notes: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dirty = Object.values(f).some(Boolean);
  useUnsavedChangesWarning(open && dirty);
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id: string }>(access.api('/customers'), { body: {
        display_name: f.display_name, phone: f.phone || null, email: f.email || null, tags: parseTags(f.tags),
        ...(access.can('customers.view_notes') && f.private_notes ? { private_notes: f.private_notes } : {}), source: 'walk_in',
      } });
      await qc.invalidateQueries({ queryKey: ['customers', access.slug] });
      toast({ tone: 'ok', text: t('states.saved') });
      setF({ display_name: '', phone: '', email: '', tags: '', private_notes: '' });
      onOpenExisting(r.id);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const existing = err instanceof ApiError && err.code === 'customer_phone_exists' ? (err.details?.customer_id as string) : null;
  const issues = err instanceof ApiError && err.code === 'validation_failed' ? (err.details?.issues as Array<{ path: string; message: string }>) : undefined;
  return (
    <Drawer open={open} onClose={onClose} title={t('customers.create_title')} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} disabled={!f.display_name.trim()} onClick={submit}>{t('actions.create')}</Button></>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Alert tone="info">{t('customers.create_note')}</Alert>
        <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
        {existing ? <Button variant="outline" size="sm" onClick={() => onOpenExisting(existing)}>{t('customers.open_existing')}</Button> : null}
        <Field label={t('customers.fields.display_name')} required>{(p) => <Input {...p} value={f.display_name} maxLength={120} onChange={(e) => setF({ ...f, display_name: e.target.value })} />}</Field>
        <Field label={t('customers.fields.phone')}>{(p) => <Input {...p} dir="ltr" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
        <Field label={t('customers.fields.email')}>{(p) => <Input {...p} dir="ltr" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label={t('customers.fields.tags')} hint={t('customers.fields.tags_hint')}>{(p) => <Input {...p} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />}</Field>
        {access.can('customers.view_notes') ? (
          <Field label={t('customers.fields.notes')} hint={t('customers.fields.notes_hint')}>{(p) => <Textarea {...p} maxLength={4000} value={f.private_notes} onChange={(e) => setF({ ...f, private_notes: e.target.value })} />}</Field>
        ) : null}
      </form>
    </Drawer>
  );
}

function CustomerDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const q = useApiQuery<Detail>(['customer', access.slug, id], access.api(`/customers/${id}`));
  if (!q.data) {
    return <Drawer open onClose={onClose} wide title={t('states.loading')}>{q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <LoadingState rows={6} />}</Drawer>;
  }
  // Re-mount the editor when the record version changes so the form starts from the saved state.
  return <CustomerDrawerLoaded key={q.data.version} d={q.data} onClose={onClose} />;
}

function toForm(d: Detail): Record<string, string> {
  return {
    display_name: d.display_name, phone: d.phone ?? '', email: d.email ?? '', tags: d.tags.join(', '),
    private_notes: d.private_notes ?? '', preferred_contact: d.preferences?.preferred_contact ?? '', language: d.preferences?.language ?? '', pref_note: d.preferences?.note ?? '',
  };
}

function CustomerDrawerLoaded({ d, onClose }: { d: Detail; onClose: () => void }) {
  const id = d.id;
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Record<string, string>>(() => toForm(d));
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const canManage = access.can('customers.manage') && !access.readOnly;
  const canNotes = access.can('customers.view_notes');
  const dirty = !!(form.display_name !== d.display_name || form.phone !== (d.phone ?? '') || form.email !== (d.email ?? '') || form.tags !== d.tags.join(', ')
    || form.private_notes !== (d.private_notes ?? '') || form.preferred_contact !== (d.preferences?.preferred_contact ?? '') || form.language !== (d.preferences?.language ?? '') || form.pref_note !== (d.preferences?.note ?? ''));
  useUnsavedChangesWarning(dirty);

  async function patch(body: Record<string, unknown>) {
    if (!d) return;
    setBusy(true); setErr(null);
    try {
      await api(access.api(`/customers/${id}`), { method: 'PATCH', body: { version: d.version, ...body } });
      await Promise.all([qc.invalidateQueries({ queryKey: ['customer', access.slug, id] }), qc.invalidateQueries({ queryKey: ['customers', access.slug] })]);
      toast({ tone: 'ok', text: t('states.saved') });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  function save() {
    if (!form) return;
    const preferences: Record<string, string> = {};
    if (form.preferred_contact) preferences.preferred_contact = form.preferred_contact;
    if (form.language) preferences.language = form.language;
    if (form.pref_note) preferences.note = form.pref_note;
    void patch({
      display_name: form.display_name, phone: form.phone || null, email: form.email || null, tags: parseTags(form.tags ?? ''), preferences,
      ...(canNotes ? { private_notes: form.private_notes || null } : {}),
    });
  }
  async function consent(channel: string, purpose: string, granted: boolean) {
    setErr(null);
    try {
      await api(access.api(`/customers/${id}/consents`), { body: { channel, purpose, granted } });
      await qc.invalidateQueries({ queryKey: ['customer', access.slug, id] });
    } catch (e) { setErr(e); }
  }

  return (
    <Drawer open onClose={onClose} wide title={d.display_name}
      footer={canManage ? <>
        <Button variant="ghost" icon={d.status === 'archived' ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />} onClick={() => patch({ archived: d.status !== 'archived' })}>{d.status === 'archived' ? t('customers.unarchive') : t('customers.archive')}</Button>
        <Button loading={busy} disabled={!dirty} onClick={save}>{t('actions.save')}</Button>
      </> : undefined}>
      {(
        <div className="flex flex-col gap-4">
          <FormErrorSummary message={err ? msg(err) : null} />
          {d.status === 'archived' ? <Alert tone="warn">{t('customers.archived_note')}</Alert> : null}
          <div className="flex flex-wrap gap-2 text-xs text-ink-muted">
            <Badge tone={d.has_account ? 'info' : 'neutral'}>{d.has_account ? t('customers.has_account') : t('customers.local_record')}</Badge>
            <span>{t('customers.detail.since')}: {formatDate(d.created_at, { locale, tz: access.timezone })}</span>
            {d.last_visit_at ? <span>{t('customers.detail.last_visit')}: {formatDate(d.last_visit_at, { locale, tz: access.timezone })}</span> : null}
          </div>
          <Card title={t('customers.detail.profile')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('customers.fields.display_name')} required>{(p) => <Input {...p} disabled={!canManage} value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />}</Field>
              <Field label={t('customers.fields.phone')}>{(p) => <Input {...p} dir="ltr" disabled={!canManage} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
              <Field label={t('customers.fields.email')}>{(p) => <Input {...p} dir="ltr" disabled={!canManage} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
              <Field label={t('customers.fields.tags')} hint={t('customers.fields.tags_hint')}>{(p) => <Input {...p} disabled={!canManage} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />}</Field>
              <Field label={t('customers.fields.preferred_contact')}>{(p) => (
                <Select {...p} disabled={!canManage} value={form.preferred_contact} onChange={(e) => setForm({ ...form, preferred_contact: e.target.value })}>
                  <option value="">{t('customers.fields.none')}</option>
                  {['phone', 'sms', 'whatsapp', 'email'].map((c) => <option key={c} value={c}>{t(`customers.contact.${c}`)}</option>)}
                </Select>
              )}</Field>
              <Field label={t('customers.fields.language')}>{(p) => (
                <Select {...p} disabled={!canManage} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                  <option value="">{t('customers.fields.none')}</option><option value="ar">العربية</option><option value="en">English</option>
                </Select>
              )}</Field>
              <Field label={t('customers.fields.preference_note')} className="sm:col-span-2">{(p) => <Input {...p} maxLength={300} disabled={!canManage} value={form.pref_note} onChange={(e) => setForm({ ...form, pref_note: e.target.value })} />}</Field>
              {canNotes ? (
                <Field label={t('customers.fields.notes')} hint={t('customers.fields.notes_hint')} className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} maxLength={4000} disabled={!canManage} value={form.private_notes} onChange={(e) => setForm({ ...form, private_notes: e.target.value })} />}</Field>
              ) : null}
            </div>
          </Card>

          <Card title={t('customers.detail.decisions')} actions={access.can('incidents.review') ? <Link className="text-sm text-luma-700 underline" href={`/app/${access.slug}/policies?customer=${id}`}>{t('customers.detail.open_policies')}</Link> : null}>
            {d.decisions.length ? (
              <ul className="flex flex-col gap-2">
                {d.decisions.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <ActionBadge action={x.action} />
                    <span className="text-ink-muted">{formatDate(x.effective_at, { locale, tz: access.timezone })}{x.expires_at ? ` → ${formatDate(x.expires_at, { locale, tz: access.timezone })}` : ''}</span>
                    {x.reason ? <span className="w-full text-ink-muted">{x.reason}</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-muted">{t('customers.detail.no_decisions')}</p>}
            {!access.can('incidents.review') && d.decisions.length ? <p className="mt-2 text-xs text-ink-muted">{t('customers.detail.effect_only')}</p> : null}
          </Card>

          <Card title={t('customers.detail.consents')}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-xs text-ink-muted"><th className="py-1 text-start font-medium" scope="col" /><>{['email', 'sms', 'whatsapp'].map((c) => <th key={c} scope="col" className="py-1 text-start font-medium">{t(`consents.channels.${c}`)}</th>)}</></tr></thead>
                <tbody>
                  {['marketing', 'reminders'].map((purpose) => (
                    <tr key={purpose} className="border-t border-line">
                      <th scope="row" className="py-2 pe-2 text-start font-medium">{t(`consents.purposes.${purpose}`)}</th>
                      {['email', 'sms', 'whatsapp'].map((ch) => {
                        const c = d.consents?.[purpose]?.[ch];
                        return (
                          <td key={ch} className="py-2 pe-2">
                            <div className="flex flex-col items-start gap-1">
                              <Badge tone={c?.granted ? 'ok' : 'neutral'}>{c?.recorded_at ? (c.granted ? t('consents.granted') : t('consents.withdrawn')) : t('consents.not_set')}</Badge>
                              {canManage ? <button className="text-xs text-luma-700 underline" onClick={() => consent(ch, purpose, !c?.granted)}>{c?.granted ? t('consents.withdraw') : t('consents.grant')}</button> : null}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-ink-muted">{t('consents.history_note')}</p>
          </Card>

          <Card title={t('customers.detail.bookings')}>
            {d.bookings.length ? (
              <ul className="divide-y divide-line text-sm">
                {d.bookings.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="font-mono text-xs" dir="ltr">{b.number}</span>
                    <span>{formatDateTime(b.starts_at, { locale, tz: b.timezone, timeFormat })}</span>
                    <Badge>{t(`account.booking_status.${b.status}`)}</Badge>
                    {b.total_minor != null ? <span>{formatMoney(b.total_minor, b.currency, locale)}</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-muted">{t('customers.detail.no_bookings')}</p>}
          </Card>

          {access.can('orders.view') ? (
            <Card title={t('customers.detail.orders')}>
              {d.orders.length ? (
                <ul className="divide-y divide-line text-sm">
                  {d.orders.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="font-mono text-xs" dir="ltr">{o.number}</span>
                      <span>{formatDate(o.created_at, { locale, tz: access.timezone })}</span>
                      <Badge>{t(`account.order_status.${o.status}`)}</Badge>
                      <span>{formatMoney(o.total_minor, o.currency, locale)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-ink-muted">{t('customers.detail.no_orders')}</p>}
            </Card>
          ) : null}

          {d.reviews.length ? (
            <Card title={t('customers.detail.reviews')}>
              <ul className="flex flex-col gap-2 text-sm">
                {d.reviews.map((r) => (
                  <li key={r.id} className="flex items-start gap-2">
                    <span className="inline-flex items-center gap-0.5 text-luma-700" aria-label={t('reviews.rating', { n: r.rating })}><Star className="size-4 fill-current" aria-hidden />{r.rating}</span>
                    <span className="flex-1">{r.comment ?? '—'}</span>
                    {r.status !== 'published' ? <Badge tone="warn">{t(`reviews.status.${r.status}`)}</Badge> : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {d.incidents ? (
            <Card title={t('customers.detail.incidents')}>
              {d.incidents.length ? (
                <ul className="flex flex-col gap-1 text-sm">
                  {d.incidents.map((i) => (
                    <li key={i.id}><Link className="text-luma-700 underline" href={`/app/${access.slug}/policies?incident=${i.id}`}>{t(`policy.types.${i.type}`)}</Link> · {t(`policy.statuses.${i.status}`)} · {formatDate(i.occurred_at, { locale, tz: access.timezone })}</li>
                  ))}
                </ul>
              ) : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
            </Card>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
