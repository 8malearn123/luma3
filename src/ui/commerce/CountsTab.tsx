'use client';

import { useMemo, useState } from 'react';
import { ClipboardCheck, Plus, Search } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import type { Unit } from '@/shared/units';
import { api, ApiError } from '../api';
import { useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { DataTable, type Column } from '../components/layout';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { parseNum, useFmt } from './common';

type CountRow = { id: string; number: string; status: 'draft' | 'applied' | 'cancelled'; branch_name: string; lines: number; counted: number; differences: number; created_at: string; applied_at: string | null };
type Line = {
  inventory_item_id: string; name: string; sku: string | null; unit: Unit; on_hand: number; reserved: number;
  counted_quantity: number | null; system_quantity: number | null; variance: number | null; variance_cost_minor: number | null; flagged: boolean;
};
type Count = CountRow & { version: number; note: string | null; tolerance_pct: number; summary: { lines: number; counted: number; uncounted: number; shortages: number; surpluses: number; flagged: number }; lines: Line[] };

const STATUS_TONE = { draft: 'warn', applied: 'ok', cancelled: 'neutral' } as const;

export function CountsTab({ openId, setOpen }: { openId: string | null; setOpen: (id: string | null) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const { when } = useFmt();
  const list = useApiQuery<CountRow[]>(['stock-counts', access.slug], access.api('/inventory/counts'));
  const [creating, setCreating] = useState(false);
  const canManage = access.can('inventory.manage') && !access.readOnly;

  const columns: Column<CountRow>[] = [
    { key: 'number', header: t('commerce.inventory.counts.col_number'), cell: (c) => <span dir="ltr" className="font-medium">{c.number}</span> },
    { key: 'status', header: t('commerce.inventory.counts.col_status'), cell: (c) => <Badge tone={STATUS_TONE[c.status]}>{t(`commerce.inventory.counts.status.${c.status}`)}</Badge> },
    { key: 'branch', header: t('commerce.inventory.counts.col_branch'), className: 'hidden md:table-cell', cell: (c) => c.branch_name },
    { key: 'progress', header: t('commerce.inventory.counts.col_progress'), cell: (c) => t('commerce.inventory.counts.progress', { counted: c.counted, lines: c.lines }) },
    { key: 'differences', header: t('commerce.inventory.counts.col_differences'), cell: (c) => (c.status === 'applied' ? (c.differences ? <Badge tone="warn">{c.differences}</Badge> : '0') : '—') },
    { key: 'date', header: t('commerce.inventory.counts.col_date'), className: 'hidden sm:table-cell', cell: (c) => when(c.applied_at ?? c.created_at) },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-ink-muted">{t('commerce.inventory.counts.hint')}</p>
        {canManage ? <Button className="shrink-0 sm:ms-auto" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('commerce.inventory.counts.new')}</Button> : null}
      </div>
      {list.isLoading ? <LoadingState rows={4} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
        <EmptyState icon={<ClipboardCheck className="size-8" aria-hidden />} title={t('commerce.inventory.counts.empty')} hint={t('commerce.inventory.counts.empty_hint')} />
      ) : (
        <DataTable rows={list.data} columns={columns} rowKey={(c) => c.id} onRowClick={(c) => setOpen(c.id)} caption={t('commerce.inventory.tab_counts')} />
      )}
      {creating ? <NewCountDrawer onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); list.refetch(); setOpen(id); }} /> : null}
      {openId ? <CountDrawer key={openId} id={openId} onClose={() => setOpen(null)} onChanged={() => list.refetch()} /> : null}
    </div>
  );
}

function NewCountDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [f, setF] = useState({ kind: 'all', tolerance: '0', note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function start() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id: string }>(access.api('/inventory/counts'), { body: { kind: f.kind, tolerance_pct: parseNum(f.tolerance) ?? 0, ...(f.note.trim() ? { note: f.note.trim() } : {}) } });
      onCreated(r.id);
    } catch (e) {
      // An open count already exists: take the user to it.
      if (e instanceof ApiError && e.code === 'count_in_progress' && typeof e.details?.id === 'string') { onCreated(e.details.id); return; }
      setErr(e);
    } finally { setBusy(false); }
  }
  return (
    <Drawer open onClose={onClose} title={t('commerce.inventory.counts.new')} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} onClick={start}>{t('commerce.inventory.counts.start')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={err ? msg(err) : null} />
        <Field label={t('commerce.inventory.counts.scope')}>{(p) => (
          <Select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="all">{t('commerce.inventory.counts.scope_all')}</option>
            <option value="retail">{t('commerce.inventory.counts.scope_retail')}</option>
            <option value="material">{t('commerce.inventory.counts.scope_material')}</option>
          </Select>
        )}</Field>
        <Field label={t('commerce.inventory.counts.tolerance')} hint={t('commerce.inventory.counts.tolerance_hint')}>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={f.tolerance} onChange={(e) => setF({ ...f, tolerance: e.target.value })} />}</Field>
        <Field label={t('commerce.inventory.counts.note')}>{(p) => <Input {...p} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
      </div>
    </Drawer>
  );
}

function CountDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const q = useApiQuery<Count>(['stock-count', access.slug, id], access.api(`/inventory/counts/${id}`));
  if (!q.data) {
    return <Drawer open wide onClose={onClose} title={t('commerce.inventory.tab_counts')}>{q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <LoadingState rows={6} />}</Drawer>;
  }
  return <CountSheet key={`${q.data.id}:${q.data.version}`} count={q.data} onClose={onClose} onChanged={() => { q.refetch(); onChanged(); }} />;
}

function CountSheet({ count: c, onClose, onChanged }: { count: Count; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const { qty, money } = useFmt();
  const draft = c.status === 'draft' && access.can('inventory.manage') && !access.readOnly;
  const initial = useMemo(() => Object.fromEntries(c.lines.map((l) => [l.inventory_item_id, l.counted_quantity == null ? '' : String(l.counted_quantity)])), [c.lines]);
  const [entries, setEntries] = useState<Record<string, string>>(initial);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<'save' | 'apply' | 'cancel' | null>(null);
  const [confirm, setConfirm] = useState<'apply' | 'cancel' | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const changed = c.lines.filter((l) => (entries[l.inventory_item_id] ?? '') !== (initial[l.inventory_item_id] ?? ''));
  useUnsavedChangesWarning(changed.length > 0);

  async function save(): Promise<number | null> {
    if (!changed.length) return c.version;
    const r = await api<Count>(access.api(`/inventory/counts/${c.id}`), {
      method: 'PATCH', body: { version: c.version, lines: changed.map((l) => ({ inventory_item_id: l.inventory_item_id, counted_quantity: parseNum(entries[l.inventory_item_id] ?? '') })) },
    });
    return r.version;
  }
  async function run(action: 'save' | 'apply' | 'cancel') {
    setBusy(action); setErr(null);
    try {
      if (action === 'cancel') {
        await api(access.api(`/inventory/counts/${c.id}/cancel`), { method: 'POST' });
        toast({ tone: 'ok', text: t('commerce.inventory.counts.cancelled') });
      } else {
        const version = await save();
        if (action === 'apply') {
          await api(access.api(`/inventory/counts/${c.id}/apply`), { body: { version } });
          toast({ tone: 'ok', text: t('commerce.inventory.counts.applied') });
        } else {
          toast({ tone: 'ok', text: t('commerce.inventory.counts.saved') });
        }
      }
      setConfirm(null);
      onChanged();
    } catch (e) { setErr(e); setConfirm(null); } finally { setBusy(null); }
  }

  const below = err instanceof ApiError && err.code === 'counted_below_reserved' ? (err.details?.items as Array<{ name: string; counted: number; reserved: number }>) : null;
  const term = search.trim().toLowerCase();
  const rows = term ? c.lines.filter((l) => l.name.toLowerCase().includes(term) || (l.sku ?? '').toLowerCase().includes(term)) : c.lines;
  const showValue = access.can('costs.view') && c.status === 'applied';

  const columns: Column<Line>[] = [
    { key: 'item', header: t('commerce.inventory.counts.col_item'), cell: (l) => <div><p className="font-medium">{l.name}</p>{l.sku ? <p dir="ltr" className="text-xs text-ink-muted">{l.sku}</p> : null}</div> },
    { key: 'system', header: t('commerce.inventory.counts.col_system'), cell: (l) => <span dir="ltr">{qty(l.system_quantity ?? l.on_hand)} {t(`commerce.inventory.unit.${l.unit}`)}</span> },
    {
      key: 'counted', header: t('commerce.inventory.counts.col_counted'), cell: (l) => (draft
        ? <Input aria-label={`${t('commerce.inventory.counts.col_counted')} — ${l.name}`} className="w-28" inputMode="decimal" dir="ltr" value={entries[l.inventory_item_id] ?? ''}
          onChange={(e) => setEntries({ ...entries, [l.inventory_item_id]: e.target.value })} />
        : l.counted_quantity == null ? <span className="text-ink-muted">{t('commerce.inventory.counts.not_counted')}</span> : <span dir="ltr">{qty(l.counted_quantity)}</span>),
    },
    {
      key: 'variance', header: t('commerce.inventory.counts.col_variance'), cell: (l) => {
        const typed = parseNum(entries[l.inventory_item_id] ?? '');
        const v = l.variance ?? (draft && typed != null ? typed - l.on_hand : null);
        if (v == null) return '—';
        return (
          <span className="inline-flex items-center gap-2">
            <span dir="ltr" className={v < 0 ? 'text-danger' : v > 0 ? 'text-ok' : ''}>{v > 0 ? '+' : ''}{qty(v)}</span>
            {l.flagged ? <Badge tone="danger">{t('commerce.inventory.counts.flagged')}</Badge> : null}
          </span>
        );
      },
    },
    ...(showValue ? [{ key: 'value', header: t('commerce.inventory.counts.col_value'), className: 'hidden sm:table-cell', cell: (l: Line) => (l.variance_cost_minor == null ? '—' : money(l.variance_cost_minor)) }] : []),
  ];

  const footer = draft ? (
    <>
      <Button variant="ghost" className="me-auto" onClick={() => setConfirm('cancel')}>{t('commerce.inventory.counts.cancel')}</Button>
      <Button variant="outline" loading={busy === 'save'} disabled={!changed.length} onClick={() => run('save')}>{t('commerce.inventory.counts.save')}</Button>
      <Button loading={busy === 'apply'} onClick={() => setConfirm('apply')}>{t('commerce.inventory.counts.apply')}</Button>
    </>
  ) : undefined;

  return (
    <Drawer open wide onClose={onClose} title={<span className="inline-flex items-center gap-2"><span dir="ltr">{c.number}</span><Badge tone={STATUS_TONE[c.status]}>{t(`commerce.inventory.counts.status.${c.status}`)}</Badge></span>} footer={footer}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={err ? msg(err) : null} />
        {below?.length ? <Alert tone="danger"><ul className="list-disc ps-5">{below.map((b) => <li key={b.name}>{t('commerce.inventory.counts.below_reserved', { name: b.name, counted: qty(b.counted), reserved: qty(b.reserved) })}</li>)}</ul></Alert> : null}
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge>{t('commerce.inventory.counts.progress', { counted: c.summary.counted, lines: c.summary.lines })}</Badge>
          {c.status === 'applied' ? <>
            <Badge tone={c.summary.shortages ? 'warn' : 'neutral'}>{t('commerce.inventory.counts.shortages', { n: c.summary.shortages })}</Badge>
            <Badge tone={c.summary.surpluses ? 'info' : 'neutral'}>{t('commerce.inventory.counts.surpluses', { n: c.summary.surpluses })}</Badge>
            <Badge tone={c.summary.flagged ? 'danger' : 'neutral'}>{t('commerce.inventory.counts.flagged_n', { n: c.summary.flagged })}</Badge>
          </> : null}
          <Badge>{t('commerce.inventory.counts.tolerance')}: {c.tolerance_pct}</Badge>
        </div>
        {c.note ? <p className="text-sm text-ink-muted">{c.note}</p> : null}
        {draft ? <p className="text-xs text-ink-muted">{t('commerce.inventory.counts.system_live')}</p> : null}
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-muted" aria-hidden />
          <Input aria-label={t('commerce.inventory.counts.search')} placeholder={t('commerce.inventory.counts.search')} className="ps-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <DataTable rows={rows} columns={columns} rowKey={(l) => l.inventory_item_id} caption={c.number} />
      </div>
      <ConfirmDialog open={confirm === 'apply'} onClose={() => setConfirm(null)} onConfirm={() => run('apply')} loading={busy === 'apply'}
        title={t('commerce.inventory.counts.apply_title')} body={t('commerce.inventory.counts.apply_body')} confirmLabel={t('commerce.inventory.counts.apply')} />
      <ConfirmDialog open={confirm === 'cancel'} onClose={() => setConfirm(null)} onConfirm={() => run('cancel')} loading={busy === 'cancel'} danger
        title={t('commerce.inventory.counts.cancel_title')} body={t('commerce.inventory.counts.cancel_body')} confirmLabel={t('commerce.inventory.counts.cancel')} />
    </Drawer>
  );
}
