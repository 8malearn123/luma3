'use client';

import { useState, type ReactNode } from 'react';
import { ArrowLeftRight, ClipboardList, Factory, MapPin, PackageCheck, Plus, Receipt, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, newIdempotencyKey } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Checkbox, Field, FormErrorSummary, Input, MoneyInput, Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, DataTable, Stat, type Column } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { parseNum, qs, useFmt } from './common';

/**
 * Multi-location inventory tabs: locations, balances, transfers, receiving,
 * supplier invoices, suppliers, issue & usage, reports and tasks. The server
 * enforces every permission; hiding here is convenience only.
 */
type Loc = { id: string; branch_id: string; branch_name: string; kind: string; name: string; code: string | null; staff_name: string | null; is_default: boolean; is_active: boolean; items_in_stock: number; value_minor?: number; resource_ids: string[] };
type ItemLite = { id: string; name: string; unit: string; branch_id: string; storage_unit?: string | null };

const TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand'> = {
  draft: 'neutral', in_transit: 'warn', completed: 'ok', cancelled: 'neutral', posted: 'ok', void: 'neutral', pending: 'info', shortage: 'danger',
  open: 'warn', resolved: 'ok', dismissed: 'neutral', not_invoiced: 'warn', partly_invoiced: 'info', invoiced: 'ok', matched: 'ok', partly_matched: 'info', unmatched: 'warn',
  unpaid: 'warn', partly_paid: 'info', paid: 'ok',
};
const today = () => new Date().toISOString().slice(0, 10);

function useLocations() {
  const access = useAccess();
  return useApiQuery<Loc[]>(['stock-locations', access.slug], access.api('/inventory/locations'));
}
function useItems() {
  const access = useAccess();
  return useApiQuery<{ items: ItemLite[] }>(['inventory-lite', access.slug], access.api('/inventory/items?limit=100&kind=all'));
}

function LocationSelect({ value, onChange, allowAll, label }: { value: string; onChange: (v: string) => void; allowAll?: boolean; label?: string }) {
  const { t } = useI18n();
  const locs = useLocations();
  return (
    <Select aria-label={label ?? t('inventory_ops.common.location')} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allowAll ? t('inventory_ops.common.all_locations') : t('inventory_ops.common.choose')}</option>
      {(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name} · {t(`inventory_ops.locations.kind.${l.kind}`)}</option>)}
    </Select>
  );
}

function ItemSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const items = useItems();
  return (
    <Select aria-label={t('inventory_ops.common.item')} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('inventory_ops.common.choose')}</option>
      {(items.data?.items ?? []).map((i) => <option key={i.id} value={i.id}>{i.name} ({t(`commerce.inventory.unit.${i.unit}`)})</option>)}
    </Select>
  );
}

function Query<T>({ q, empty, icon, children }: { q: { isLoading: boolean; error: unknown; data?: T; refetch: () => unknown }; empty: string; icon?: ReactNode; children: (d: T) => ReactNode }) {
  if (q.isLoading) return <LoadingState rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data as T;
  if (!d || (Array.isArray(d) && !d.length)) return <EmptyState icon={icon} title={empty} />;
  return <>{children(d)}</>;
}

function useSubmit() {
  const msg = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); return true; } catch (e) { setErr(msg(e)); return false; } finally { setBusy(false); }
  };
  return { busy, err, run };
}

// ── Locations ───────────────────────────────────────────────────────────────
export function LocationsTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const toast = useToast();
  const locs = useLocations();
  const settings = useApiQuery<{ transfer_confirmation: string }>(['inventory-settings', access.slug], access.api('/inventory/settings'));
  const [creating, setCreating] = useState(false);
  const canManage = access.can('inventory.manage') && !access.readOnly;
  const columns: Column<Loc>[] = [
    { key: 'name', header: t('inventory_ops.locations.name'), cell: (l) => <div><p className="font-medium">{l.name}</p>{l.code ? <p dir="ltr" className="text-xs text-ink-muted">{l.code}</p> : null}</div> },
    { key: 'kind', header: t('inventory_ops.locations.kind_label'), cell: (l) => <span className="inline-flex gap-1"><Badge tone={l.kind === 'quarantine' ? 'danger' : l.kind === 'main' ? 'brand' : 'neutral'}>{t(`inventory_ops.locations.kind.${l.kind}`)}</Badge>{l.is_default ? <Badge tone="info">{t('inventory_ops.locations.default')}</Badge> : null}</span> },
    { key: 'branch', header: t('inventory_ops.common.branch'), className: 'hidden md:table-cell', cell: (l) => l.branch_name },
    { key: 'staff', header: t('inventory_ops.locations.staff'), className: 'hidden lg:table-cell', cell: (l) => l.staff_name ?? '—' },
    { key: 'items', header: t('inventory_ops.locations.items_in_stock'), cell: (l) => l.items_in_stock },
    { key: 'value', header: t('inventory_ops.common.value'), className: 'hidden sm:table-cell', cell: (l) => (l.value_minor === undefined ? '—' : money(l.value_minor)) },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-ink-muted">{t('inventory_ops.locations.hint')}</p>
        {canManage ? <Button className="shrink-0 sm:ms-auto" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('inventory_ops.locations.new')}</Button> : null}
      </div>
      <Query q={locs} empty={t('inventory_ops.locations.empty')} icon={<MapPin className="size-8" aria-hidden />}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(l) => l.id} caption={t('inventory_ops.tabs.locations')} />}
      </Query>
      {access.can('business.manage') && settings.data ? (
        <Card title={t('inventory_ops.locations.settings')}>
          <Field label={t('inventory_ops.locations.confirmation')} hint={t('inventory_ops.locations.confirmation_hint')}>{(p) => (
            <Select {...p} value={settings.data!.transfer_confirmation} disabled={access.readOnly} onChange={async (e) => {
              await api(access.api('/inventory/settings'), { method: 'PUT', body: { transfer_confirmation: e.target.value } });
              settings.refetch(); toast({ tone: 'ok', text: t('inventory_ops.common.saved') });
            }}>
              <option value="immediate">{t('inventory_ops.locations.confirmation_immediate')}</option>
              <option value="confirm_receipt">{t('inventory_ops.locations.confirmation_confirm')}</option>
            </Select>
          )}</Field>
        </Card>
      ) : null}
      {creating ? <NewLocationDrawer onClose={() => setCreating(false)} onDone={() => { setCreating(false); locs.refetch(); }} /> : null}
    </div>
  );
}

function NewLocationDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const s = useSubmit();
  const [f, setF] = useState({ kind: 'station', name: '', code: '', staff_id: '', resource_ids: [] as string[] });
  const staff = useApiQuery<Array<{ id: string; display_name: string }>>(['staff-lite', access.slug], access.api('/staff'), { enabled: access.can('staff.edit', 'schedule.manage', 'catalog.edit', 'bookings.manage') });
  const res = useApiQuery<{ resources: Array<{ id: string; name: string }> }>(['resources-lite', access.slug], access.api('/resources'), { enabled: access.can('catalog.edit', 'schedule.manage', 'bookings.manage') });
  const submit = () => s.run(async () => {
    await api(access.api('/inventory/locations'), { body: { kind: f.kind, name: f.name.trim(), ...(f.code.trim() ? { code: f.code.trim() } : {}), ...(f.staff_id ? { staff_id: f.staff_id } : {}), ...(f.kind === 'station' ? { resource_ids: f.resource_ids } : {}) } });
    onDone();
  });
  return (
    <Drawer open onClose={onClose} title={t('inventory_ops.locations.new')} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={s.busy} disabled={!f.name.trim()} onClick={submit}>{t('inventory_ops.common.create')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={s.err} />
        <Field label={t('inventory_ops.locations.kind_label')}>{(p) => (
          <Select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {(['station', 'custody', 'quarantine', 'branch'] as const).map((k) => <option key={k} value={k}>{t(`inventory_ops.locations.kind.${k}`)}</option>)}
          </Select>
        )}</Field>
        {f.kind === 'quarantine' ? <Alert tone="warn">{t('inventory_ops.locations.quarantine_hint')}</Alert> : null}
        <Field label={t('inventory_ops.locations.name')} required>{(p) => <Input {...p} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t('inventory_ops.locations.code')}>{(p) => <Input {...p} dir="ltr" maxLength={32} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
        {f.kind === 'custody' ? (
          <Field label={t('inventory_ops.locations.staff')} required>{(p) => (
            <Select {...p} value={f.staff_id} onChange={(e) => setF({ ...f, staff_id: e.target.value })}>
              <option value="">{t('inventory_ops.common.choose')}</option>
              {(staff.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </Select>
          )}</Field>
        ) : null}
        {f.kind === 'station' && res.data?.resources.length ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">{t('inventory_ops.locations.chairs')}</legend>
            {res.data.resources.map((r) => <Checkbox key={r.id} label={r.name} checked={f.resource_ids.includes(r.id)} onChange={(on) => setF({ ...f, resource_ids: on ? [...f.resource_ids, r.id] : f.resource_ids.filter((x) => x !== r.id) })} />)}
          </fieldset>
        ) : null}
      </div>
    </Drawer>
  );
}

// ── Balances ────────────────────────────────────────────────────────────────
type Bal = { inventory_item_id: string; name: string; unit: string; location_id: string; location_name: string; location_kind: string; on_hand: number; reserved: number; in_transit: number; available: number; reorder_level: number | null; below_reorder: boolean; value_minor?: number | null };

export function BalancesTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { qty, money } = useFmt();
  const [loc, setLoc] = useState('');
  const [nonzero, setNonzero] = useState(true);
  const q = useApiQuery<{ items: Bal[]; total: number }>(['stock-balances', access.slug, loc, nonzero], access.api(`/inventory/balances${qs({ location_id: loc, nonzero: nonzero ? '1' : '' })}`));
  const costs = access.can('costs.view');
  const columns: Column<Bal>[] = [
    { key: 'item', header: t('inventory_ops.common.item'), cell: (b) => b.name },
    { key: 'loc', header: t('inventory_ops.common.location'), cell: (b) => <span className="inline-flex items-center gap-1">{b.location_name}{b.location_kind === 'quarantine' ? <Badge tone="danger">{t('inventory_ops.locations.kind.quarantine')}</Badge> : null}</span> },
    { key: 'on_hand', header: t('inventory_ops.common.on_hand'), cell: (b) => `${qty(b.on_hand)} ${t(`commerce.inventory.unit.${b.unit}`)}` },
    { key: 'available', header: t('inventory_ops.common.available'), cell: (b) => <span className="inline-flex gap-1">{qty(b.available)}{b.below_reorder ? <Badge tone="warn">{t('inventory_ops.common.below_reorder')}</Badge> : null}</span> },
    { key: 'transit', header: t('inventory_ops.common.in_transit'), className: 'hidden md:table-cell', cell: (b) => (b.in_transit ? qty(b.in_transit) : '—') },
    { key: 'reorder', header: t('inventory_ops.common.reorder_level'), className: 'hidden lg:table-cell', cell: (b) => (b.reorder_level == null ? '—' : qty(b.reorder_level)) },
    ...(costs ? [{ key: 'value', header: t('inventory_ops.common.value'), className: 'hidden sm:table-cell', cell: (b: Bal) => (b.value_minor == null ? '—' : money(b.value_minor)) }] : []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">{t('inventory_ops.balances.hint')}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="sm:w-72"><LocationSelect value={loc} onChange={setLoc} allowAll /></div>
        <Checkbox label={t('inventory_ops.balances.nonzero')} checked={nonzero} onChange={setNonzero} />
      </div>
      {!costs ? <p className="text-xs text-ink-muted">{t('inventory_ops.common.no_costs')}</p> : null}
      <Query q={q} empty={t('inventory_ops.balances.empty')}>
        {(d) => (d.items.length ? <DataTable rows={d.items} columns={columns} rowKey={(b) => `${b.inventory_item_id}:${b.location_id}`} caption={t('inventory_ops.tabs.balances')} /> : <EmptyState title={t('inventory_ops.balances.empty')} />)}
      </Query>
    </div>
  );
}

// ── Transfers ───────────────────────────────────────────────────────────────
type Transfer = { id: string; number: string; status: string; mode: string; from_location_name: string; to_location_name: string; lines: number; created_at: string; version: number };

export function TransfersTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { when } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const list = useApiQuery<Transfer[]>(['stock-transfers', access.slug], access.api('/inventory/transfers'));
  const [creating, setCreating] = useState(false);
  const can = access.can('inventory.transfer') && !access.readOnly;
  const act = async (id: string, action: 'receive' | 'cancel' | 'dispatch') => {
    try {
      await api(access.api(`/inventory/transfers/${id}/${action}`), { body: {}, idempotencyKey: newIdempotencyKey() });
      toast({ tone: 'ok', text: t(action === 'receive' ? 'inventory_ops.transfers.received' : 'inventory_ops.common.saved') });
      list.refetch();
    } catch (e) { toast({ tone: 'danger', text: msg(e) }); }
  };
  const columns: Column<Transfer>[] = [
    { key: 'number', header: t('inventory_ops.common.number'), cell: (r) => <span dir="ltr" className="font-medium">{r.number}</span> },
    { key: 'route', header: `${t('inventory_ops.common.from')} → ${t('inventory_ops.common.to')}`, cell: (r) => `${r.from_location_name} → ${r.to_location_name}` },
    { key: 'status', header: t('inventory_ops.common.status'), cell: (r) => <Badge tone={TONE[r.status]}>{t(`inventory_ops.transfers.status.${r.status}`)}</Badge> },
    { key: 'lines', header: t('inventory_ops.transfers.lines'), className: 'hidden md:table-cell', cell: (r) => r.lines },
    { key: 'date', header: t('inventory_ops.common.date'), className: 'hidden sm:table-cell', cell: (r) => when(r.created_at) },
    {
      key: 'actions', header: '', cell: (r) => (!can ? null : r.status === 'in_transit' ? (
        <span className="inline-flex gap-1"><Button size="sm" onClick={() => act(r.id, 'receive')}>{t('inventory_ops.transfers.receive')}</Button><Button size="sm" variant="ghost" onClick={() => act(r.id, 'cancel')}>{t('inventory_ops.transfers.cancel')}</Button></span>
      ) : r.status === 'draft' ? (
        <span className="inline-flex gap-1"><Button size="sm" onClick={() => act(r.id, 'dispatch')}>{t('inventory_ops.transfers.dispatch')}</Button><Button size="sm" variant="ghost" onClick={() => act(r.id, 'cancel')}>{t('inventory_ops.transfers.cancel')}</Button></span>
      ) : null),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-ink-muted">{t('inventory_ops.transfers.hint')}</p>
        {can ? <Button className="shrink-0 sm:ms-auto" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('inventory_ops.transfers.new')}</Button> : null}
      </div>
      <Query q={list} empty={t('inventory_ops.transfers.empty')} icon={<ArrowLeftRight className="size-8" aria-hidden />}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} caption={t('inventory_ops.tabs.transfers')} />}
      </Query>
      {creating ? <NewTransferDrawer onClose={() => setCreating(false)} onDone={() => { setCreating(false); list.refetch(); toast({ tone: 'ok', text: t('inventory_ops.transfers.done') }); }} /> : null}
    </div>
  );
}

type LineDraft = { inventory_item_id: string; quantity: string };

function LinesEditor({ lines, setLines, extra }: { lines: Array<LineDraft & Record<string, string>>; setLines: (l: Array<LineDraft & Record<string, string>>) => void; extra?: (l: LineDraft & Record<string, string>, set: (patch: Record<string, string>) => void) => ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      {lines.map((l, i) => {
        const set = (patch: Record<string, string>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-line p-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="sm:w-56"><ItemSelect value={l.inventory_item_id} onChange={(v) => set({ inventory_item_id: v })} /></div>
            <Input aria-label={t('inventory_ops.common.quantity')} className="sm:w-28" inputMode="decimal" dir="ltr" placeholder={t('inventory_ops.common.quantity')} value={l.quantity} onChange={(e) => set({ quantity: e.target.value })} />
            {extra?.(l, set)}
            <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} onClick={() => setLines(lines.filter((_, j) => j !== i))}>{t('inventory_ops.common.remove')}</Button>
          </div>
        );
      })}
      <Button variant="secondary" size="sm" icon={<Plus className="size-4" />} onClick={() => setLines([...lines, { inventory_item_id: '', quantity: '' }])}>{t('inventory_ops.common.add_line')}</Button>
    </div>
  );
}

function NewTransferDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const s = useSubmit();
  const [key] = useState(newIdempotencyKey);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Array<LineDraft & Record<string, string>>>([{ inventory_item_id: '', quantity: '' }]);
  const valid = from && to && from !== to && lines.length && lines.every((l) => l.inventory_item_id && (parseNum(l.quantity) ?? 0) > 0);
  const submit = () => s.run(async () => {
    await api(access.api('/inventory/transfers'), { idempotencyKey: key, body: { from_location_id: from, to_location_id: to, ...(note.trim() ? { note: note.trim() } : {}), lines: lines.map((l) => ({ inventory_item_id: l.inventory_item_id, quantity: parseNum(l.quantity) })) } });
    onDone();
  });
  return (
    <Drawer open wide onClose={onClose} title={t('inventory_ops.transfers.new')} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={s.busy} disabled={!valid} onClick={submit}>{t('inventory_ops.transfers.dispatch')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={s.err} />
        <Alert tone="info">{t('inventory_ops.transfers.hint')}</Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('inventory_ops.common.from')}>{() => <LocationSelect value={from} onChange={setFrom} label={t('inventory_ops.common.from')} />}</Field>
          <Field label={t('inventory_ops.common.to')}>{() => <LocationSelect value={to} onChange={setTo} label={t('inventory_ops.common.to')} />}</Field>
        </div>
        <LinesEditor lines={lines} setLines={setLines} />
        <Field label={t('inventory_ops.common.note')}>{(p) => <Input {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Drawer>
  );
}

// ── Receiving ───────────────────────────────────────────────────────────────
type ReceiptRow = { id: string; number: string; status: string; received_on: string; supplier_name: string | null; location_name: string; lines: number; received_qty: number; invoiced_qty: number; matching: string };

export function ReceiptsTab() {
  const { t } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const [notInvoiced, setNotInvoiced] = useState(false);
  const list = useApiQuery<ReceiptRow[]>(['purchase-receipts', access.slug, notInvoiced], access.api(`/purchasing/receipts${qs({ not_invoiced: notInvoiced ? '1' : '' })}`));
  const [creating, setCreating] = useState(false);
  const can = access.can('purchasing.receive') && !access.readOnly;
  const postIt = async (id: string) => {
    try { await api(access.api(`/purchasing/receipts/${id}/post`), { body: {}, idempotencyKey: newIdempotencyKey() }); list.refetch(); toast({ tone: 'ok', text: t('inventory_ops.common.saved') }); } catch (e) { toast({ tone: 'danger', text: msg(e) }); }
  };
  const columns: Column<ReceiptRow>[] = [
    { key: 'number', header: t('inventory_ops.common.number'), cell: (r) => <span dir="ltr" className="font-medium">{r.number}</span> },
    { key: 'supplier', header: t('inventory_ops.common.supplier'), cell: (r) => r.supplier_name ?? '—' },
    { key: 'loc', header: t('inventory_ops.common.location'), className: 'hidden md:table-cell', cell: (r) => r.location_name },
    { key: 'date', header: t('inventory_ops.common.date'), className: 'hidden sm:table-cell', cell: (r) => r.received_on },
    { key: 'status', header: t('inventory_ops.common.status'), cell: (r) => <span className="inline-flex gap-1"><Badge tone={TONE[r.status]}>{t(`inventory_ops.receipts.status.${r.status}`)}</Badge>{r.status === 'posted' ? <Badge tone={TONE[r.matching]}>{t(`inventory_ops.receipts.matching.${r.matching}`)}</Badge> : null}</span> },
    { key: 'actions', header: '', cell: (r) => (can && r.status === 'draft' ? <Button size="sm" onClick={() => postIt(r.id)}>{t('inventory_ops.common.post')}</Button> : null) },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-ink-muted">{t('inventory_ops.receipts.hint')}</p>
        {can ? <Button className="shrink-0 sm:ms-auto" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('inventory_ops.receipts.new')}</Button> : null}
      </div>
      <Checkbox label={t('inventory_ops.receipts.not_invoiced_only')} checked={notInvoiced} onChange={setNotInvoiced} />
      <Query q={list} empty={t('inventory_ops.receipts.empty')} icon={<PackageCheck className="size-8" aria-hidden />}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} caption={t('inventory_ops.tabs.receipts')} />}
      </Query>
      {creating ? <NewReceiptDrawer onClose={() => setCreating(false)} onDone={() => { setCreating(false); list.refetch(); }} /> : null}
    </div>
  );
}

function useSuppliers() {
  const access = useAccess();
  return useApiQuery<Array<{ id: string; name: string; is_active: boolean; balance_minor?: number; phone: string | null; tax_number: string | null }>>(['suppliers', access.slug], access.api('/purchasing/suppliers'));
}

function SupplierSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const sup = useSuppliers();
  return (
    <Select aria-label={t('inventory_ops.common.supplier')} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('inventory_ops.common.choose')}</option>
      {(sup.data ?? []).filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </Select>
  );
}

function NewReceiptDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const s = useSubmit();
  const [key] = useState(newIdempotencyKey);
  const costs = access.can('costs.view');
  const [f, setF] = useState({ supplier_id: '', location_id: '', received_on: today(), reference: '', post: true });
  const [lines, setLines] = useState<Array<LineDraft & Record<string, string>>>([{ inventory_item_id: '', quantity: '', uom: 'usage', cost: '', batch_no: '', expiry_date: '' }]);
  const valid = lines.length && lines.every((l) => l.inventory_item_id && (parseNum(l.quantity) ?? 0) > 0);
  const submit = () => s.run(async () => {
    await api(access.api('/purchasing/receipts'), { idempotencyKey: key, body: {
      ...(f.supplier_id ? { supplier_id: f.supplier_id } : {}), ...(f.location_id ? { location_id: f.location_id } : {}), received_on: f.received_on,
      ...(f.reference.trim() ? { reference: f.reference.trim() } : {}), post: f.post,
      lines: lines.map((l) => ({ inventory_item_id: l.inventory_item_id, quantity: parseNum(l.quantity), uom: l.uom || 'usage',
        ...(costs && l.cost ? { unit_cost_minor: Math.round((parseNum(l.cost ?? '') ?? 0) * 100) } : {}),
        ...(l.batch_no ? { batch_no: l.batch_no } : {}), ...(l.expiry_date ? { expiry_date: l.expiry_date } : {}) })),
    } });
    onDone();
  });
  return (
    <Drawer open wide onClose={onClose} title={t('inventory_ops.receipts.new')} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={s.busy} disabled={!valid} onClick={submit}>{t('inventory_ops.common.save')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={s.err} />
        <Alert tone="info">{t('inventory_ops.receipts.hint')}</Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('inventory_ops.common.supplier')}>{() => <SupplierSelect value={f.supplier_id} onChange={(v) => setF({ ...f, supplier_id: v })} />}</Field>
          <Field label={t('inventory_ops.common.location')}>{() => <LocationSelect value={f.location_id} onChange={(v) => setF({ ...f, location_id: v })} />}</Field>
          <Field label={t('inventory_ops.receipts.received_on')}>{(p) => <Input {...p} type="date" dir="ltr" value={f.received_on} onChange={(e) => setF({ ...f, received_on: e.target.value })} />}</Field>
          <Field label={t('inventory_ops.receipts.reference')}>{(p) => <Input {...p} dir="ltr" maxLength={80} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
        </div>
        <LinesEditor lines={lines} setLines={setLines} extra={(l, set) => (
          <>
            <Select aria-label={t('inventory_ops.receipts.uom')} className="sm:w-36" value={l.uom ?? 'usage'} onChange={(e) => set({ uom: e.target.value })}>
              <option value="usage">{t('inventory_ops.receipts.uom_usage')}</option><option value="storage">{t('inventory_ops.receipts.uom_storage')}</option>
            </Select>
            {costs ? <Input aria-label={t('inventory_ops.common.unit_cost')} className="sm:w-28" inputMode="decimal" dir="ltr" placeholder={t('inventory_ops.common.unit_cost')} value={l.cost ?? ''} onChange={(e) => set({ cost: e.target.value })} /> : null}
            <Input aria-label={t('inventory_ops.receipts.batch_no')} className="sm:w-28" dir="ltr" placeholder={t('inventory_ops.receipts.batch_no')} value={l.batch_no ?? ''} onChange={(e) => set({ batch_no: e.target.value })} />
            <Input aria-label={t('inventory_ops.receipts.expiry')} className="sm:w-40" type="date" dir="ltr" value={l.expiry_date ?? ''} onChange={(e) => set({ expiry_date: e.target.value })} />
          </>
        )} />
        <Checkbox label={t('inventory_ops.receipts.post_now')} checked={f.post} onChange={(v) => setF({ ...f, post: v })} />
      </div>
    </Drawer>
  );
}

// ── Supplier invoices ───────────────────────────────────────────────────────
type InvoiceRow = { id: string; supplier_name: string; supplier_id: string; invoice_number: string; invoice_date: string; status: string; total_minor: number; paid_minor: number; outstanding_minor: number; matching: string; payment_status: string | null };

export function InvoicesTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const list = useApiQuery<InvoiceRow[]>(['supplier-invoices', access.slug], access.api('/purchasing/invoices'));
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<InvoiceRow | null>(null);
  const canManage = access.can('purchasing.manage') && !access.readOnly;
  const canPay = access.can('purchasing.pay') && !access.readOnly;
  const postIt = async (id: string) => {
    try { await api(access.api(`/purchasing/invoices/${id}/post`), { body: {}, idempotencyKey: newIdempotencyKey() }); list.refetch(); } catch (e) { toast({ tone: 'danger', text: msg(e) }); }
  };
  const columns: Column<InvoiceRow>[] = [
    { key: 'number', header: t('inventory_ops.invoices.invoice_number'), cell: (r) => <span dir="ltr" className="font-medium">{r.invoice_number}</span> },
    { key: 'supplier', header: t('inventory_ops.common.supplier'), cell: (r) => r.supplier_name },
    { key: 'date', header: t('inventory_ops.invoices.invoice_date'), className: 'hidden md:table-cell', cell: (r) => r.invoice_date },
    { key: 'total', header: t('inventory_ops.common.total'), cell: (r) => money(r.total_minor) },
    {
      key: 'status', header: t('inventory_ops.common.status'), cell: (r) => (
        <span className="inline-flex flex-wrap gap-1"><Badge tone={TONE[r.status]}>{t(`inventory_ops.invoices.status.${r.status}`)}</Badge><Badge tone={TONE[r.matching]}>{t(`inventory_ops.invoices.matching.${r.matching}`)}</Badge>
          {r.payment_status ? <Badge tone={TONE[r.payment_status]}>{t(`inventory_ops.invoices.payment.${r.payment_status}`)}</Badge> : null}</span>
      ),
    },
    {
      key: 'actions', header: '', cell: (r) => (r.status === 'draft' && canManage ? <Button size="sm" onClick={() => postIt(r.id)}>{t('inventory_ops.common.post')}</Button>
        : r.status === 'posted' && canPay && r.outstanding_minor > 0 ? <Button size="sm" onClick={() => setPaying(r)}>{t('inventory_ops.invoices.pay')}</Button> : null),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-ink-muted">{t('inventory_ops.invoices.hint')}</p>
        {canManage ? <Button className="shrink-0 sm:ms-auto" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('inventory_ops.invoices.new')}</Button> : null}
      </div>
      <Query q={list} empty={t('inventory_ops.invoices.empty')} icon={<Receipt className="size-8" aria-hidden />}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} caption={t('inventory_ops.tabs.invoices')} />}
      </Query>
      {creating ? <NewInvoiceDrawer onClose={() => setCreating(false)} onDone={() => { setCreating(false); list.refetch(); }} /> : null}
      {paying ? <PayDrawer invoice={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); list.refetch(); }} /> : null}
    </div>
  );
}

function NewInvoiceDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const s = useSubmit();
  const [f, setF] = useState({ supplier_id: '', invoice_number: '', invoice_date: today(), due_date: '', post: false });
  const receipts = useApiQuery<ReceiptRow[]>(['purchase-receipts', access.slug, true], access.api('/purchasing/receipts?not_invoiced=1'));
  const [receiptId, setReceiptId] = useState('');
  const receipt = useApiQuery<{ lines: Array<{ id: string; inventory_item_id: string; name: string; not_invoiced_qty: number; unit_cost_minor?: number | null }> }>(['purchase-receipt', access.slug, receiptId], receiptId ? access.api(`/purchasing/receipts/${receiptId}`) : null);
  const [lines, setLines] = useState<Array<LineDraft & Record<string, string>>>([{ inventory_item_id: '', quantity: '', cost: '', tax: '', receipt_line_id: '' }]);
  const fromReceipt = () => {
    if (!receipt.data) return;
    setLines(receipt.data.lines.filter((l) => l.not_invoiced_qty > 0).map((l) => ({ inventory_item_id: l.inventory_item_id, quantity: String(l.not_invoiced_qty), cost: l.unit_cost_minor == null ? '' : String(l.unit_cost_minor / 100), tax: '', receipt_line_id: l.id })));
  };
  const valid = f.supplier_id && f.invoice_number.trim() && lines.length && lines.every((l) => (parseNum(l.quantity) ?? 0) > 0 && parseNum(l.cost ?? '') != null);
  const submit = () => s.run(async () => {
    await api(access.api('/purchasing/invoices'), { body: {
      supplier_id: f.supplier_id, invoice_number: f.invoice_number.trim(), invoice_date: f.invoice_date, ...(f.due_date ? { due_date: f.due_date } : {}), post: f.post,
      lines: lines.map((l) => {
        const q = parseNum(l.quantity) ?? 0;
        return { ...(l.inventory_item_id ? { inventory_item_id: l.inventory_item_id } : {}), quantity: q, unit_cost_minor: Math.round((parseNum(l.cost ?? '') ?? 0) * 100), tax_minor: Math.round((parseNum(l.tax ?? '') ?? 0) * 100),
          links: l.receipt_line_id ? [{ receipt_line_id: l.receipt_line_id, quantity: q }] : [] };
      }),
    } });
    onDone();
  });
  return (
    <Drawer open wide onClose={onClose} title={t('inventory_ops.invoices.new')} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={s.busy} disabled={!valid} onClick={submit}>{t('inventory_ops.common.save')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={s.err} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('inventory_ops.common.supplier')} required>{() => <SupplierSelect value={f.supplier_id} onChange={(v) => setF({ ...f, supplier_id: v })} />}</Field>
          <Field label={t('inventory_ops.invoices.invoice_number')} required>{(p) => <Input {...p} dir="ltr" maxLength={60} value={f.invoice_number} onChange={(e) => setF({ ...f, invoice_number: e.target.value })} />}</Field>
          <Field label={t('inventory_ops.invoices.invoice_date')}>{(p) => <Input {...p} type="date" dir="ltr" value={f.invoice_date} onChange={(e) => setF({ ...f, invoice_date: e.target.value })} />}</Field>
          <Field label={t('inventory_ops.invoices.due_date')}>{(p) => <Input {...p} type="date" dir="ltr" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} />}</Field>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label={t('inventory_ops.invoices.link_receipt')} className="sm:w-72">{(p) => (
            <Select {...p} value={receiptId} onChange={(e) => setReceiptId(e.target.value)}>
              <option value="">{t('inventory_ops.common.none')}</option>
              {(receipts.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.number} · {r.supplier_name ?? '—'}</option>)}
            </Select>
          )}</Field>
          <Button variant="secondary" disabled={!receipt.data} onClick={fromReceipt}>{t('inventory_ops.common.add_line')}</Button>
        </div>
        <LinesEditor lines={lines} setLines={setLines} extra={(l, set) => (
          <>
            <Input aria-label={t('inventory_ops.common.unit_cost')} className="sm:w-28" inputMode="decimal" dir="ltr" placeholder={t('inventory_ops.common.unit_cost')} value={l.cost ?? ''} onChange={(e) => set({ cost: e.target.value })} />
            <Input aria-label={t('inventory_ops.invoices.tax')} className="sm:w-24" inputMode="decimal" dir="ltr" placeholder={t('inventory_ops.invoices.tax')} value={l.tax ?? ''} onChange={(e) => set({ tax: e.target.value })} />
            {l.receipt_line_id ? <Badge tone="info">{t('inventory_ops.invoices.matched')}</Badge> : null}
          </>
        )} />
        <Checkbox label={t('inventory_ops.common.post')} checked={f.post} onChange={(v) => setF({ ...f, post: v })} />
      </div>
    </Drawer>
  );
}

function PayDrawer({ invoice, onClose, onDone }: { invoice: InvoiceRow; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const s = useSubmit();
  const [key] = useState(newIdempotencyKey);
  const [f, setF] = useState<{ amount: number | null; method: string; paid_on: string; reference: string }>({ amount: invoice.outstanding_minor, method: 'bank', paid_on: today(), reference: '' });
  const submit = () => s.run(async () => {
    await api(access.api('/purchasing/payments'), { idempotencyKey: key, body: { supplier_id: invoice.supplier_id, invoice_id: invoice.id, amount_minor: f.amount, method: f.method, paid_on: f.paid_on, ...(f.reference.trim() ? { reference: f.reference.trim() } : {}) } });
    onDone();
  });
  return (
    <Drawer open onClose={onClose} title={`${t('inventory_ops.invoices.pay')} ${invoice.invoice_number}`} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={s.busy} disabled={!f.amount} onClick={submit}>{t('inventory_ops.invoices.pay')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={s.err} />
        <p className="text-sm">{t('inventory_ops.invoices.outstanding')}: {money(invoice.outstanding_minor)}</p>
        <Field label={t('inventory_ops.common.total')}>{(p) => <MoneyInput {...p} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />}</Field>
        <Field label={t('inventory_ops.invoices.method')}>{(p) => (
          <Select {...p} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            <option value="bank">{t('inventory_ops.invoices.method_bank')}</option><option value="cash">{t('inventory_ops.invoices.method_cash')}</option>
          </Select>
        )}</Field>
        <Field label={t('inventory_ops.invoices.paid_on')}>{(p) => <Input {...p} type="date" dir="ltr" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />}</Field>
        <Field label={t('inventory_ops.receipts.reference')}>{(p) => <Input {...p} dir="ltr" maxLength={80} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
      </div>
    </Drawer>
  );
}

// ── Suppliers ───────────────────────────────────────────────────────────────
export function SuppliersTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const list = useSuppliers();
  const s = useSubmit();
  const [f, setF] = useState({ name: '', phone: '', tax_number: '' });
  const can = access.can('purchasing.manage', 'inventory.manage') && !access.readOnly;
  type S = NonNullable<typeof list.data>[number];
  const columns: Column<S>[] = [
    { key: 'name', header: t('inventory_ops.suppliers.name'), cell: (r) => r.name },
    { key: 'phone', header: t('inventory_ops.suppliers.phone'), className: 'hidden sm:table-cell', cell: (r) => <span dir="ltr">{r.phone ?? '—'}</span> },
    { key: 'tax', header: t('inventory_ops.suppliers.tax_number'), className: 'hidden md:table-cell', cell: (r) => <span dir="ltr">{r.tax_number ?? '—'}</span> },
    { key: 'balance', header: t('inventory_ops.suppliers.balance'), cell: (r) => (r.balance_minor === undefined ? '—' : money(r.balance_minor)) },
  ];
  const add = () => s.run(async () => {
    await api(access.api('/purchasing/suppliers'), { body: { name: f.name.trim(), ...(f.phone.trim() ? { phone: f.phone.trim() } : {}), ...(f.tax_number.trim() ? { tax_number: f.tax_number.trim() } : {}) } });
    setF({ name: '', phone: '', tax_number: '' }); list.refetch();
  });
  return (
    <div className="flex flex-col gap-3">
      {can ? (
        <Card title={t('inventory_ops.suppliers.new')}>
          <FormErrorSummary message={s.err} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label={t('inventory_ops.suppliers.name')} required className="sm:w-64">{(p) => <Input {...p} maxLength={160} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label={t('inventory_ops.suppliers.phone')} className="sm:w-40">{(p) => <Input {...p} dir="ltr" maxLength={40} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
            <Field label={t('inventory_ops.suppliers.tax_number')} className="sm:w-40">{(p) => <Input {...p} dir="ltr" maxLength={40} value={f.tax_number} onChange={(e) => setF({ ...f, tax_number: e.target.value })} />}</Field>
            <Button loading={s.busy} disabled={!f.name.trim()} onClick={add}>{t('inventory_ops.common.create')}</Button>
          </div>
        </Card>
      ) : null}
      <Query q={list} empty={t('inventory_ops.suppliers.empty')} icon={<Factory className="size-8" aria-hidden />}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} caption={t('inventory_ops.tabs.suppliers')} />}
      </Query>
    </div>
  );
}

// ── Issue & usage ───────────────────────────────────────────────────────────
type Consumption = { id: string; source: string; item_name: string; unit: string; location_name: string; service_name_ar: string | null; service_name_en: string | null; performer_name: string | null; chair_name: string | null;
  expected_qty: number; actual_qty: number | null; posted_qty: number; shortage_qty: number; waste_qty: number; total_cost_minor?: number; status: string; reason: string | null; version: number; created_at: string };

export function ConsumptionTab() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { qty, money, when } = useFmt();
  const toast = useToast();
  const list = useApiQuery<Consumption[]>(['consumptions', access.slug], access.api('/inventory/consumptions'));
  const s = useSubmit();
  const [f, setF] = useState({ inventory_item_id: '', location_id: '', quantity: '', reason: '' });
  const [editing, setEditing] = useState<Consumption | null>(null);
  const canIssue = access.can('inventory.manage') && !access.readOnly;
  const canAdjust = access.can('inventory.adjust_usage', 'inventory.manage') && !access.readOnly;
  const columns: Column<Consumption>[] = [
    { key: 'item', header: t('inventory_ops.common.item'), cell: (c) => <div><p>{c.item_name}</p><p className="text-xs text-ink-muted">{c.source === 'manual' ? c.reason : (locale === 'ar' ? c.service_name_ar ?? c.service_name_en : c.service_name_en ?? c.service_name_ar)}</p></div> },
    { key: 'loc', header: t('inventory_ops.common.location'), className: 'hidden md:table-cell', cell: (c) => `${c.location_name}${c.chair_name ? ` · ${c.chair_name}` : ''}` },
    { key: 'perf', header: t('inventory_ops.consumption.performer'), className: 'hidden lg:table-cell', cell: (c) => c.performer_name ?? '—' },
    { key: 'exp', header: t('inventory_ops.consumption.expected'), cell: (c) => qty(c.expected_qty) },
    { key: 'act', header: t('inventory_ops.consumption.actual'), cell: (c) => qty(c.actual_qty ?? c.expected_qty) },
    { key: 'status', header: t('inventory_ops.common.status'), cell: (c) => <Badge tone={TONE[c.status]}>{t(`inventory_ops.consumption.status.${c.status}`)}{c.shortage_qty ? ` (${qty(c.shortage_qty)})` : ''}</Badge> },
    { key: 'cost', header: t('inventory_ops.common.value'), className: 'hidden sm:table-cell', cell: (c) => (c.total_cost_minor === undefined ? '—' : money(c.total_cost_minor)) },
    { key: 'date', header: t('inventory_ops.common.date'), className: 'hidden xl:table-cell', cell: (c) => when(c.created_at) },
    { key: 'actions', header: '', cell: (c) => (canAdjust && c.status !== 'cancelled' && c.source === 'service' ? <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>{t('inventory_ops.consumption.correct')}</Button> : null) },
  ];
  const issue = () => s.run(async () => {
    await api(access.api('/inventory/issue'), { body: { inventory_item_id: f.inventory_item_id, ...(f.location_id ? { location_id: f.location_id } : {}), quantity: parseNum(f.quantity), reason: f.reason.trim() } });
    setF({ inventory_item_id: '', location_id: '', quantity: '', reason: '' }); list.refetch(); toast({ tone: 'ok', text: t('inventory_ops.common.saved') });
  });
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="info">{t('inventory_ops.consumption.performance_note')}</Alert>
      {canIssue ? (
        <Card title={t('inventory_ops.consumption.issue')}>
          <p className="mb-2 text-sm text-ink-muted">{t('inventory_ops.consumption.issue_hint')}</p>
          <FormErrorSummary message={s.err} />
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="sm:w-56"><ItemSelect value={f.inventory_item_id} onChange={(v) => setF({ ...f, inventory_item_id: v })} /></div>
            <div className="sm:w-56"><LocationSelect value={f.location_id} onChange={(v) => setF({ ...f, location_id: v })} /></div>
            <Input aria-label={t('inventory_ops.common.quantity')} className="sm:w-28" inputMode="decimal" dir="ltr" placeholder={t('inventory_ops.common.quantity')} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
            <Input aria-label={t('inventory_ops.common.reason')} className="sm:w-64" maxLength={500} placeholder={t('inventory_ops.common.reason')} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            <Button loading={s.busy} disabled={!f.inventory_item_id || !(parseNum(f.quantity) ?? 0) || f.reason.trim().length < 3} onClick={issue}>{t('inventory_ops.consumption.issue')}</Button>
          </div>
        </Card>
      ) : null}
      <Query q={list} empty={t('inventory_ops.consumption.empty')} icon={<ClipboardList className="size-8" aria-hidden />}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(c) => c.id} caption={t('inventory_ops.tabs.consumption')} />}
      </Query>
      {editing ? <CorrectUsageDrawer c={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); list.refetch(); }} /> : null}
    </div>
  );
}

function CorrectUsageDrawer({ c, onClose, onDone }: { c: Consumption; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const s = useSubmit();
  const [actual, setActual] = useState(String(c.actual_qty ?? c.expected_qty));
  const [waste, setWaste] = useState('');
  const [reason, setReason] = useState('');
  const submit = () => s.run(async () => {
    const a = parseNum(actual);
    if (a != null && a !== (c.actual_qty ?? c.expected_qty)) await api(access.api(`/inventory/consumptions/${c.id}`), { method: 'PATCH', body: { actual_qty: a, reason: reason.trim(), version: c.version } });
    const w = parseNum(waste);
    if (w && w > 0) await api(access.api(`/inventory/consumptions/${c.id}/waste`), { body: { quantity: w, reason: reason.trim() } });
    onDone();
  });
  return (
    <Drawer open onClose={onClose} title={`${t('inventory_ops.consumption.correct')} · ${c.item_name}`} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={s.busy} disabled={reason.trim().length < 3} onClick={submit}>{t('inventory_ops.common.save')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={s.err} />
        <p className="text-sm text-ink-muted">{t('inventory_ops.consumption.expected')}: {c.expected_qty} · {t('inventory_ops.consumption.posted')}: {c.posted_qty}</p>
        <Field label={t('inventory_ops.consumption.actual')}>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={actual} onChange={(e) => setActual(e.target.value)} />}</Field>
        <Field label={t('inventory_ops.consumption.waste')}>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={waste} onChange={(e) => setWaste(e.target.value)} />}</Field>
        <Field label={t('inventory_ops.common.reason')} required>{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Drawer>
  );
}

// ── Tasks ───────────────────────────────────────────────────────────────────
type Task = { id: string; kind: string; status: string; item_name: string | null; unit: string | null; location_name: string | null; payload: Record<string, any>; created_at: string };

export function TasksTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { when, qty } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const [status, setStatus] = useState('open');
  const list = useApiQuery<Task[]>(['inventory-tasks', access.slug, status], access.api(`/inventory/tasks${qs({ status })}`));
  const can = access.can('inventory.manage') && !access.readOnly;
  const act = async (task: Task, action: string) => {
    const resolution = action === 'write_off' ? window.prompt(t('inventory_ops.common.reason')) ?? '' : undefined;
    if (action === 'write_off' && (resolution ?? '').trim().length < 3) return;
    try { await api(access.api(`/inventory/tasks/${task.id}`), { body: { action, ...(resolution ? { resolution } : {}) } }); list.refetch(); } catch (e) { toast({ tone: 'danger', text: msg(e) }); }
  };
  const columns: Column<Task>[] = [
    { key: 'kind', header: t('inventory_ops.locations.kind_label'), cell: (r) => <Badge tone={r.kind === 'shortage' ? 'danger' : 'warn'}>{t(`inventory_ops.tasks.kind.${r.kind}`)}</Badge> },
    { key: 'item', header: t('inventory_ops.common.item'), cell: (r) => r.item_name ?? r.payload.name ?? '—' },
    { key: 'loc', header: t('inventory_ops.common.location'), className: 'hidden md:table-cell', cell: (r) => r.location_name ?? '—' },
    { key: 'detail', header: t('inventory_ops.tasks.missing'), cell: (r) => (r.kind === 'shortage' ? qty(Number(r.payload.missing ?? 0)) : r.kind === 'expiry' ? `${r.payload.batch_no} · ${r.payload.expiry_date}` : qty(Number(r.payload.available ?? 0))) },
    { key: 'date', header: t('inventory_ops.common.date'), className: 'hidden sm:table-cell', cell: (r) => when(r.created_at) },
    {
      key: 'actions', header: '', cell: (r) => (!can || r.status !== 'open' ? <Badge tone={TONE[r.status]}>{t(`inventory_ops.tasks.status.${r.status}`)}</Badge> : r.kind === 'shortage' ? (
        <span className="inline-flex gap-1"><Button size="sm" onClick={() => act(r, 'post_remaining')}>{t('inventory_ops.tasks.post_remaining')}</Button><Button size="sm" variant="ghost" onClick={() => act(r, 'write_off')}>{t('inventory_ops.tasks.write_off')}</Button></span>
      ) : <span className="inline-flex gap-1"><Button size="sm" onClick={() => act(r, 'resolve')}>{t('inventory_ops.tasks.resolve')}</Button><Button size="sm" variant="ghost" onClick={() => act(r, 'dismiss')}>{t('inventory_ops.tasks.dismiss')}</Button></span>),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Select aria-label={t('inventory_ops.common.status')} className="sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
        {(['open', 'resolved', 'dismissed', 'all'] as const).map((s) => <option key={s} value={s}>{t(`inventory_ops.tasks.status.${s}`)}</option>)}
      </Select>
      <Query q={list} empty={t('inventory_ops.tasks.empty')}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} caption={t('inventory_ops.tabs.tasks')} />}
      </Query>
    </div>
  );
}

// ── Reports ─────────────────────────────────────────────────────────────────
const REPORT_KINDS = ['balances', 'movements', 'transfers', 'consumption', 'expected_vs_actual', 'waste', 'shortages', 'near_expiry', 'service_material_cost', 'supplier_matching', 'valuation'] as const;
const ADVANCED = new Set(['consumption', 'expected_vs_actual', 'waste', 'service_material_cost', 'supplier_matching']);
/** Columns shown per report, in order (labels: inventory_ops.reports.col.*). Cost columns appear only when the server sent them. */
const REPORT_COLUMNS: Record<Exclude<(typeof REPORT_KINDS)[number], 'valuation'>, string[]> = {
  balances: ['name', 'location_name', 'location_kind', 'on_hand', 'reserved', 'in_transit', 'available', 'value_minor'],
  movements: ['created_at', 'kind', 'item_name', 'location_name', 'quantity', 'location_on_hand_after', 'total_cost_minor', 'reason', 'actor_name'],
  transfers: ['number', 'created_at', 'from_location_name', 'to_location_name', 'lines', 'mode', 'status'],
  consumption: ['group_label', 'item_name', 'lines', 'expected_qty', 'actual_qty', 'posted_qty', 'waste_qty', 'shortage_qty', 'cost_minor'],
  expected_vs_actual: ['service_name', 'item_name', 'visits', 'expected_qty', 'actual_qty', 'difference', 'difference_pct'],
  waste: ['created_at', 'item_name', 'location_name', 'quantity', 'reason', 'cost_minor', 'actor_name'],
  shortages: ['created_at', 'kind', 'item_name', 'location_name'],
  near_expiry: ['item_name', 'batch_no', 'expiry_date', 'location_name', 'quantity', 'expired'],
  service_material_cost: ['service_name', 'visits', 'cost_minor', 'cost_per_visit_minor'],
  supplier_matching: ['invoice_number', 'invoice_date', 'supplier_name', 'total_minor', 'matching', 'status', 'payment_status', 'outstanding_minor'],
};
const QTY_COLUMNS = new Set(['on_hand', 'reserved', 'in_transit', 'available', 'quantity', 'location_on_hand_after', 'expected_qty', 'actual_qty', 'posted_qty', 'waste_qty', 'shortage_qty', 'difference']);

export function ReportsTab() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money, when, qty } = useFmt();
  const [kind, setKind] = useState<(typeof REPORT_KINDS)[number]>('balances');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [group, setGroup] = useState('service');
  const available = REPORT_KINDS.filter((k) => (k === 'valuation' ? access.can('costs.view') : k === 'supplier_matching' ? access.can('purchasing.manage', 'purchasing.pay', 'finance.view') : true));
  const locked = ADVANCED.has(kind) && !access.hasFeature('feature.inventory_reports_advanced');
  const q = useApiQuery<Record<string, any>>(['inventory-report', access.slug, kind, from, to, group], locked ? null : access.api(`/inventory/reports/${kind}${qs({ from, to, group: kind === 'consumption' ? group : '' })}`));
  const rows: Array<Record<string, unknown>> = (q.data?.items ?? q.data?.invoices ?? q.data?.tasks ?? []) as Array<Record<string, unknown>>;
  // Rows carry service names in both languages; the column shows the reader's.
  const shown = rows.map((r) => ('service_name_ar' in r || 'service_name_en' in r ? { ...r, service_name: pick(r.service_name_ar as string | null, r.service_name_en as string | null) || null } : r));
  const cols = kind === 'valuation' ? [] : REPORT_COLUMNS[kind].filter((c) => shown.some((r) => c in r));
  const enumLabel: Record<string, (v: string) => string> = {
    kind: (v) => t(kind === 'shortages' ? `inventory_ops.tasks.kind.${v}` : `inventory_ops.movement_kind.${v}`),
    location_kind: (v) => t(`inventory_ops.locations.kind.${v}`),
    status: (v) => t(kind === 'supplier_matching' ? `inventory_ops.invoices.status.${v}` : `inventory_ops.transfers.status.${v}`),
    mode: (v) => t(`inventory_ops.transfers.mode.${v}`),
    matching: (v) => t(`inventory_ops.invoices.matching.${v}`),
    payment_status: (v) => t(`inventory_ops.invoices.payment.${v}`),
  };
  const fmt = (k: string, v: unknown, r: Record<string, unknown>): ReactNode => {
    if (v == null || v === '') return '—';
    if (typeof v === 'boolean') return t(v ? 'inventory_ops.reports.yes' : 'inventory_ops.reports.no');
    if (/_minor$/.test(k)) return <span dir="ltr">{money(Math.round(Number(v)))}</span>;
    if (k === 'created_at') return when(String(v));
    if (k === 'difference_pct') return <span dir="ltr">{qty(Number(v))}%</span>;
    if (QTY_COLUMNS.has(k)) return <span dir="ltr">{qty(Number(v))}{typeof r.unit === 'string' ? ` ${t(`commerce.inventory.unit.${r.unit}`)}` : ''}</span>;
    if (enumLabel[k]) return enumLabel[k](String(v));
    return String(v);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <Field label={t('inventory_ops.reports.choose')} className="sm:w-72">{(p) => (
          <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as (typeof REPORT_KINDS)[number])}>
            {available.map((k) => <option key={k} value={k}>{t(`inventory_ops.reports.kind.${k}`)}</option>)}
          </Select>
        )}</Field>
        <Field label={t('inventory_ops.reports.from')} className="sm:w-44">{(p) => <Input {...p} type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('inventory_ops.reports.to')} className="sm:w-44">{(p) => <Input {...p} type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        {kind === 'consumption' ? (
          <Field label={t('inventory_ops.reports.group_by')} className="sm:w-44">{(p) => (
            <Select {...p} value={group} onChange={(e) => setGroup(e.target.value)}>
              {(['service', 'booking', 'chair', 'performer', 'item', 'location'] as const).map((g) => <option key={g} value={g}>{t(`inventory_ops.reports.group.${g}`)}</option>)}
            </Select>
          )}</Field>
        ) : null}
      </div>
      {['consumption', 'expected_vs_actual', 'service_material_cost'].includes(kind) ? <Alert tone="info">{t('inventory_ops.consumption.performance_note')}</Alert> : null}
      {locked ? <Alert tone="warn">{t('inventory_ops.reports.advanced_needed')}</Alert> : q.isLoading ? <LoadingState rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : kind === 'valuation' && q.data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label={t('inventory_ops.reports.valuation.inventory_value')} value={money(q.data.inventory_value_minor)} />
          <Stat label={t('inventory_ops.reports.valuation.ledger')} value={money(q.data.ledger_inventory_minor)} hint={`${t('inventory_ops.reports.valuation.difference')}: ${money(q.data.difference_minor)}`} tone={q.data.difference_minor ? 'warn' : 'ok'} />
          <Stat label={t('inventory_ops.reports.valuation.ap')} value={money(q.data.accounts_payable_minor)} />
          <Stat label={t('inventory_ops.reports.valuation.grni')} value={money(q.data.received_not_invoiced_minor)} />
          <Stat label={t('inventory_ops.reports.valuation.input_tax')} value={money(q.data.input_tax_minor)} />
          <Stat label={t('inventory_ops.reports.valuation.shrinkage')} value={money(q.data.shrinkage_minor)} />
        </div>
      ) : !rows.length ? <EmptyState title={t('inventory_ops.reports.empty')} /> : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <caption className="sr-only">{t(`inventory_ops.reports.kind.${kind}`)}</caption>
            <thead><tr>{cols.map((c) => <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 text-start font-medium text-ink-muted">{t(`inventory_ops.reports.col.${c}`)}</th>)}</tr></thead>
            <tbody>{shown.map((r, i) => <tr key={i} className="border-t border-line">{cols.map((c) => <td key={c} className="px-3 py-2">{fmt(c, r[c], r)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
