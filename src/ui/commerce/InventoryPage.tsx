'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Boxes, FlaskConical, Gauge, Plus, Search, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { UNITS, convertUnits, unitsCompatible, type Unit } from '@/shared/units';
import { api, ApiError } from '../api';
import { useApiQuery, useDebounced, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Checkbox, Field, FormErrorSummary, Input, MoneyInput, Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, DataTable, PageHeader, Tabs, type Column } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { OffsetPager, parseNum, qs, useFmt } from './common';
import { StockPanel } from './StockPanel';
import { CountsTab } from './CountsTab';

type Item = {
  id: string; name: string; kind: 'retail' | 'material' | 'both'; unit: Unit; on_hand: number; reserved: number; available: number;
  low_stock_threshold: number | null; low_stock: boolean; idle_reason?: 'no_recipe' | 'not_consumed' | 'not_sold' | null; cost_per_unit_minor?: number | null; is_active: boolean; variant_id: string | null; sku: string | null;
};
const LIMIT = 25;

export function InventoryPage() {
  const { t } = useI18n();
  const access = useAccess();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab = (['items', 'counts', 'recipes', 'capacity'] as const).find((x) => x === sp.get('tab')) ?? 'items';
  const setParam = (k: string, v: string | null) => {
    const u = new URLSearchParams(sp.toString());
    if (v) u.set(k, v); else u.delete(k);
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  };
  return (
    <div>
      <PageHeader title={t('commerce.inventory.title')} subtitle={t('commerce.inventory.subtitle')} />
      <Tabs value={tab} onChange={(v) => setParam('tab', v === 'items' ? null : v)} items={[
        { value: 'items', label: t('commerce.inventory.tab_items') },
        { value: 'counts', label: t('commerce.inventory.tab_counts') },
        { value: 'recipes', label: t('commerce.inventory.tab_recipes') },
        { value: 'capacity', label: t('commerce.inventory.tab_capacity') },
      ]} />
      {tab === 'items' ? <ItemsTab openId={sp.get('item')} setOpen={(id) => setParam('item', id)} initialIdle={sp.get('idle') === '1'} />
        : tab === 'counts' ? <CountsTab openId={sp.get('count')} setOpen={(id) => setParam('count', id)} /> : tab === 'recipes' ? <RecipesTab /> : <CapacityTab />}
    </div>
  );
}

function ItemsTab({ openId, setOpen, initialIdle }: { openId: string | null; setOpen: (id: string | null) => void; initialIdle: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const { qty } = useFmt();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [low, setLow] = useState(false);
  const [idle, setIdle] = useState(initialIdle);
  const [inactive, setInactive] = useState(false);
  const [sort, setSort] = useState('name');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim(), 300);
  const query = qs({ q, kind, low: low ? '1' : '', idle: idle ? '1' : '', include_inactive: inactive ? '1' : '', sort, dir: sort === 'updated' ? 'desc' : 'asc', limit: LIMIT, offset });
  const list = useApiQuery<{ items: Item[]; total: number; low_stock_count: number }>(['inventory', access.slug, query], access.api(`/inventory/items${query}`));
  const canManage = access.can('inventory.manage') && !access.readOnly;

  const columns: Column<Item>[] = [
    { key: 'name', header: t('commerce.inventory.col_item'), cell: (i) => <div><p className="font-medium">{i.name}</p>{i.sku ? <p dir="ltr" className="text-xs text-ink-muted">{i.sku}</p> : null}</div> },
    { key: 'kind', header: t('commerce.inventory.col_kind'), className: 'hidden sm:table-cell', cell: (i) => <Badge tone={i.kind === 'retail' ? 'info' : i.kind === 'both' ? 'brand' : 'neutral'}>{t(`commerce.inventory.kind.${i.kind}`)}</Badge> },
    { key: 'on_hand', header: t('commerce.inventory.col_on_hand'), className: 'hidden md:table-cell', cell: (i) => qty(i.on_hand) },
    { key: 'reserved', header: t('commerce.inventory.col_reserved'), className: 'hidden md:table-cell', cell: (i) => qty(i.reserved) },
    {
      key: 'available', header: t('commerce.inventory.col_available'), cell: (i) => (
        <span className="inline-flex items-center gap-2">{qty(i.available)} {t(`commerce.inventory.unit.${i.unit}`)}
          {i.available <= 0 ? <Badge tone="danger">{t('commerce.products.out')}</Badge> : i.low_stock ? <Badge tone="warn">{t('commerce.products.low')}</Badge> : null}
          {!i.is_active ? <Badge>{t('fields.inactive')}</Badge> : null}
          {i.idle_reason ? <span title={t(`commerce.inventory.idle_hint.${i.idle_reason}`)}><Badge tone="info">{t(`commerce.inventory.idle.${i.idle_reason}`)}</Badge></span> : null}
        </span>
      ),
    },
  ];

  return (
    <div>
      {list.data?.low_stock_count ? <Alert tone="warn" className="mb-3">{t('commerce.inventory.low_count', { n: list.data.low_stock_count })}</Alert> : null}
      {idle && list.data?.items.length ? <Alert tone="info" className="mb-3">{list.data.total} {t('commerce.inventory.idle_count')}</Alert> : null}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-muted" aria-hidden />
          <Input aria-label={t('actions.search')} placeholder={t('commerce.inventory.search')} className="ps-9" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
        </div>
        <Select aria-label={t('commerce.inventory.col_kind')} className="sm:w-44" value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }}>
          <option value="">{t('commerce.inventory.all_kinds')}</option>
          {(['retail', 'material', 'both'] as const).map((k) => <option key={k} value={k}>{t(`commerce.inventory.kind.${k}`)}</option>)}
        </Select>
        <Select aria-label={t('commerce.products.sort')} className="sm:w-40" value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); }}>
          <option value="name">{t('commerce.products.sort_name')}</option>
          <option value="available">{t('commerce.inventory.col_available')}</option>
          <option value="updated">{t('commerce.products.sort_created')}</option>
        </Select>
        <Checkbox label={t('commerce.inventory.low_only')} checked={low} onChange={(v) => { setLow(v); setOffset(0); }} />
        <Checkbox label={t('commerce.inventory.idle_only')} checked={idle} onChange={(v) => { setIdle(v); setOffset(0); }} />
        <Checkbox label={t('fields.inactive')} checked={inactive} onChange={(v) => { setInactive(v); setOffset(0); }} />
        {canManage ? <Button className="sm:ms-auto" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('commerce.inventory.new_material')}</Button> : null}
      </div>
      {list.isLoading ? <LoadingState rows={5} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.items.length ? (
        <EmptyState icon={<Boxes className="size-8" aria-hidden />} title={t('commerce.inventory.empty')} hint={t('commerce.inventory.empty_hint')} />
      ) : (
        <>
          <DataTable rows={list.data.items} columns={columns} rowKey={(i) => i.id} onRowClick={(i) => setOpen(i.id)} caption={t('commerce.inventory.tab_items')} />
          <OffsetPager offset={offset} limit={LIMIT} total={list.data.total} onChange={setOffset} />
        </>
      )}
      {openId ? <ItemDrawer key={openId} id={openId} onClose={() => setOpen(null)} onChanged={() => list.refetch()} /> : null}
      {creating ? <NewMaterialDrawer onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); list.refetch(); setOpen(id); }} /> : null}
    </div>
  );
}

function ItemDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const q = useApiQuery<Item & { updated_at: string }>(['inventory-item', access.slug, id], access.api(`/inventory/items/${id}`));
  if (!q.data) {
    return <Drawer open onClose={onClose} title={t('commerce.inventory.tab_items')}>{q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <LoadingState />}</Drawer>;
  }
  return <ItemForm key={q.data.id} item={q.data} onClose={onClose} onChanged={() => { q.refetch(); onChanged(); }} />;
}

function ItemForm({ item: i, onClose, onChanged }: { item: Item; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const canManage = access.can('inventory.manage') && !access.readOnly;
  const canCost = access.can('costs.view');
  const [f, setF] = useState({ name: i.name, threshold: i.low_stock_threshold == null ? '' : String(i.low_stock_threshold), cost: i.cost_per_unit_minor ?? null, active: i.is_active, both: i.kind === 'both' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api(access.api(`/inventory/items/${i.id}`), {
        method: 'PATCH', body: {
          ...(i.kind === 'material' ? { name: f.name } : {}), low_stock_threshold: parseNum(f.threshold), is_active: f.active,
          ...(canCost ? { cost_per_unit_minor: f.cost } : {}), ...(i.variant_id ? { kind: f.both ? 'both' : 'retail' } : {}),
        },
      });
      toast({ tone: 'ok', text: t('commerce.inventory.saved') });
      onChanged();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} title={i.name} footer={canManage ? <><Button variant="ghost" onClick={onClose}>{t('actions.close')}</Button><Button loading={busy} onClick={save}>{t('actions.save')}</Button></> : undefined}>
      <div className="flex flex-col gap-5">
        <FormErrorSummary message={err ? msg(err) : null} />
        <div className="flex gap-2"><Badge>{t(`commerce.inventory.kind.${i.kind}`)}</Badge><Badge>{t(`commerce.inventory.unit.${i.unit}`)}</Badge></div>
        <StockPanel itemId={i.id} unit={i.unit} onHand={i.on_hand} reserved={i.reserved} canManage={canManage} onChanged={onChanged} />
        <fieldset disabled={!canManage} className="flex flex-col gap-3">
          {i.kind === 'material' ? <Field label={t('commerce.inventory.name')}>{(p) => <Input {...p} value={f.name} maxLength={160} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field> : null}
          <Field label={`${t('commerce.inventory.threshold')} (${t(`commerce.inventory.unit.${i.unit}`)})`}>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} />}</Field>
          {canCost ? <Field label={t('commerce.inventory.cost_per_unit')}>{(p) => <MoneyInput {...p} value={f.cost} onChange={(m) => setF({ ...f, cost: m })} />}</Field> : null}
          {i.variant_id ? <Checkbox label={t('commerce.inventory.mark_both')} checked={f.both} onChange={(v) => setF({ ...f, both: v })} disabled={!canManage} /> : null}
          <Checkbox label={t('commerce.inventory.active')} checked={f.active} onChange={(v) => setF({ ...f, active: v })} disabled={!canManage} />
        </fieldset>
      </div>
    </Drawer>
  );
}

function NewMaterialDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [f, setF] = useState({ name: '', unit: 'ml' as Unit, threshold: '', initial: '', cost: null as number | null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useUnsavedChangesWarning(!!f.name);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id: string }>(access.api('/inventory/items'), {
        body: { name: f.name.trim(), unit: f.unit, low_stock_threshold: parseNum(f.threshold), ...(parseNum(f.initial) ? { initial_quantity: parseNum(f.initial) } : {}), ...(access.can('costs.view') && f.cost != null ? { cost_per_unit_minor: f.cost } : {}) },
      });
      onCreated(r.id);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const issues = err instanceof ApiError && err.code === 'validation_failed' ? (err.details?.issues as Array<{ path: string; message: string }>) : undefined;
  return (
    <Drawer open onClose={onClose} title={t('commerce.inventory.new_material')} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} disabled={!f.name.trim()} onClick={save}>{t('actions.create')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
        <Field label={t('commerce.inventory.name')} required>{(p) => <Input {...p} value={f.name} maxLength={160} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t('commerce.inventory.unit_field')}>{(p) => <Select {...p} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value as Unit })}>{UNITS.map((u) => <option key={u} value={u}>{t(`commerce.inventory.unit.${u}`)}</option>)}</Select>}</Field>
        <Field label={t('commerce.inventory.initial_quantity')}>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={f.initial} onChange={(e) => setF({ ...f, initial: e.target.value })} />}</Field>
        <Field label={t('commerce.inventory.threshold')}>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} />}</Field>
        {access.can('costs.view') ? <Field label={t('commerce.inventory.cost_per_unit')}>{(p) => <MoneyInput {...p} value={f.cost} onChange={(m) => setF({ ...f, cost: m })} />}</Field> : null}
      </div>
    </Drawer>
  );
}

// ── Recipes ─────────────────────────────────────────────────────────────────
type RecipeService = {
  id: string; name_ar: string | null; name_en: string | null; is_active: boolean;
  lines: Array<{ inventory_item_id: string; quantity: number; unit: Unit; item_name: string; item_unit: Unit; item_quantity: number | null; approved_at: string | null; approved_by_name: string | null }>;
};

function RecipesTab() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { qty } = useFmt();
  const list = useApiQuery<RecipeService[]>(['recipes', access.slug], access.api('/inventory/recipes'));
  const [editing, setEditing] = useState<RecipeService | null>(null);
  const canManage = access.can('inventory.manage') && !access.readOnly;
  if (list.isLoading) return <LoadingState rows={4} />;
  if (list.error) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  if (!list.data?.length) return <EmptyState icon={<FlaskConical className="size-8" aria-hidden />} title={t('commerce.inventory.no_services')} />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">{t('commerce.inventory.recipes_hint')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        {list.data.map((s) => (
          <Card key={s.id} title={pick(s.name_ar, s.name_en)} actions={canManage ? <Button size="sm" variant="outline" onClick={() => setEditing(s)}>{t('commerce.inventory.edit_recipe')}</Button> : null}>
            {s.lines.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {s.lines.map((l) => (
                  <li key={l.inventory_item_id} className="flex justify-between gap-2">
                    <span>{l.item_name}</span>
                    <span dir="ltr">{qty(l.quantity)} {t(`commerce.inventory.unit.${l.unit}`)}{l.unit !== l.item_unit && l.item_quantity != null ? ` = ${qty(l.item_quantity)} ${t(`commerce.inventory.unit.${l.item_unit}`)}` : ''}</span>
                  </li>
                ))}
                {s.lines[0]?.approved_by_name ? <li className="pt-1 text-xs text-ink-muted">{t('commerce.inventory.approved_by', { name: s.lines[0].approved_by_name })}</li> : null}
              </ul>
            ) : <p className="text-sm text-ink-muted">{t('commerce.inventory.no_recipe')}</p>}
          </Card>
        ))}
      </div>
      {editing ? <RecipeDrawer service={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.refetch(); }} /> : null}
    </div>
  );
}

function RecipeDrawer({ service, onClose, onSaved }: { service: RecipeService; onClose: () => void; onSaved: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const mats = useApiQuery<{ items: Item[] }>(['inventory', access.slug, 'materials'], access.api('/inventory/items?limit=100&sort=name'));
  const materials = (mats.data?.items ?? []).filter((i) => i.kind !== 'retail');
  const [lines, setLines] = useState(service.lines.map((l) => ({ inventory_item_id: l.inventory_item_id, quantity: String(l.quantity), unit: l.unit })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const unitOf = (id: string) => materials.find((m) => m.id === id)?.unit;

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api(access.api(`/inventory/recipes/${service.id}`), { method: 'PUT', body: { lines: lines.filter((l) => l.inventory_item_id).map((l) => ({ inventory_item_id: l.inventory_item_id, quantity: parseNum(l.quantity) ?? 0, unit: l.unit })) } });
      toast({ tone: 'ok', text: t('commerce.inventory.recipe_saved') });
      onSaved();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} title={`${t('commerce.inventory.edit_recipe')} — ${pick(service.name_ar, service.name_en)}`} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} onClick={save}>{t('actions.save')}</Button></>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={err ? msg(err) : null} />
        {mats.isLoading ? <LoadingState /> : !materials.length ? <Alert tone="info">{t('commerce.inventory.no_materials')}</Alert> : null}
        {lines.map((l, idx) => {
          const iu = unitOf(l.inventory_item_id);
          const bad = iu && !unitsCompatible(l.unit, iu);
          const conv = iu && !bad && l.unit !== iu ? convertUnits(parseNum(l.quantity) ?? 0, l.unit, iu) : null;
          return (
            <div key={idx} className="grid grid-cols-[1fr_6rem_6rem_auto] items-end gap-2">
              <Field label={t('commerce.inventory.material')}>{(p) => (
                <Select {...p} value={l.inventory_item_id} onChange={(e) => { const u = unitOf(e.target.value); setLines(lines.map((x, j) => (j === idx ? { ...x, inventory_item_id: e.target.value, unit: u ?? x.unit } : x))); }}>
                  <option value="">—</option>
                  {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({t(`commerce.inventory.unit.${m.unit}`)})</option>)}
                </Select>
              )}</Field>
              <Field label={t('commerce.inventory.per_booking')} error={bad ? t('commerce.inventory.incompatible') : null}>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === idx ? { ...x, quantity: e.target.value } : x)))} />}</Field>
              <Field label={t('commerce.inventory.in_unit')} hint={conv != null && iu ? `= ${conv} ${t(`commerce.inventory.unit.${iu}`)}` : undefined}>{(p) => (
                <Select {...p} value={l.unit} onChange={(e) => setLines(lines.map((x, j) => (j === idx ? { ...x, unit: e.target.value as Unit } : x)))}>
                  {UNITS.filter((u) => !iu || unitsCompatible(u, iu)).map((u) => <option key={u} value={u}>{t(`commerce.inventory.unit.${u}`)}</option>)}
                </Select>
              )}</Field>
              <IconButton label={t('actions.delete')} className="mb-0.5" onClick={() => setLines(lines.filter((_, j) => j !== idx))}><Trash2 className="size-4" /></IconButton>
            </div>
          );
        })}
        {materials.length ? <Button variant="outline" size="sm" className="self-start" icon={<Plus className="size-4" />} onClick={() => setLines([...lines, { inventory_item_id: '', quantity: '', unit: 'ml' }])}>{t('commerce.inventory.add_line')}</Button> : null}
      </div>
    </Drawer>
  );
}

// ── Capacity ────────────────────────────────────────────────────────────────
type Estimate =
  | { status: 'ok'; bookings: number; limitingItemId: string; method: string; lines: Array<{ inventoryItemId: string; name: string; unit: Unit; available: number; perBooking: number; bookings: number }>; disclosures: string[] }
  | { status: 'insufficient_data'; reasons: string[]; method: string };

function CapacityTab() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { qty } = useFmt();
  const list = useApiQuery<Array<{ id: string; name_ar: string | null; name_en: string | null; estimate: Estimate }>>(['capacity', access.slug], access.api('/inventory/capacity'));
  if (list.isLoading) return <LoadingState rows={4} />;
  if (list.error) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  if (!list.data?.length) return <EmptyState icon={<Gauge className="size-8" aria-hidden />} title={t('commerce.inventory.no_services')} />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">{t('commerce.inventory.capacity_hint')}</p>
      <details className="rounded-xl border border-line bg-white p-3 text-sm"><summary className="cursor-pointer font-medium">{t('commerce.inventory.method')}</summary><p className="mt-2 text-ink-muted">{t('commerce.inventory.method_text')}</p></details>
      <div className="grid gap-3 md:grid-cols-2">
        {list.data.map((s) => {
          const e = s.estimate;
          return (
            <Card key={s.id} title={pick(s.name_ar, s.name_en)}>
              {e.status === 'ok' ? (
                <div className="flex flex-col gap-2 text-sm">
                  <p className="text-lg font-semibold text-luma-900">{t('commerce.inventory.enough_for', { n: e.bookings })}</p>
                  <p className="text-ink-muted">{t('commerce.inventory.limiting', { name: e.lines.find((l) => l.inventoryItemId === e.limitingItemId)?.name ?? '' })}</p>
                  <ul className="flex flex-col gap-0.5 text-xs">
                    {e.lines.map((l) => <li key={l.inventoryItemId} className="flex justify-between gap-2"><span>{l.name} ({t(`commerce.inventory.unit.${l.unit}`)})</span><span dir="ltr">{qty(l.available)} ÷ {qty(l.perBooking)} = {l.bookings}</span></li>)}
                  </ul>
                  <p className="text-xs text-ink-muted">{t('commerce.inventory.disclosures')}: {e.disclosures.map((d) => t(`commerce.inventory.disclosure.${d}`)).join(' · ')}</p>
                </div>
              ) : (
                <div className="flex flex-col gap-1 text-sm">
                  <Badge tone="warn" className="self-start">{t('commerce.inventory.insufficient')}</Badge>
                  <ul className="list-disc ps-5 text-ink-muted">{[...new Set(e.reasons.map((r) => r.split(':')[0]!))].map((r) => <li key={r}>{t(`commerce.inventory.reasons.${r}`)}</li>)}</ul>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
