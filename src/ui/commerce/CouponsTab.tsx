'use client';

import { useState } from 'react';
import { Plus, TicketPercent } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { DataTable, type Column } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { parseNum, useFmt } from './common';

type Coupon = {
  id: string; code: string; kind: 'percent' | 'fixed'; value: number; applies_to: string; min_subtotal_minor: number; max_redemptions: number | null;
  per_customer_limit: number; redemptions_count: number; starts_at: string | null; ends_at: string | null; is_active: boolean; source: string;
};

export function CouponsTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const msg = useErrorMessage();
  const toast = useToast();
  const list = useApiQuery<Coupon[]>(['coupons', access.slug], access.api('/coupons'));
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(c: Coupon) {
    setBusyId(c.id);
    try { await api(access.api(`/coupons/${c.id}`), { method: 'PATCH', body: { is_active: !c.is_active } }); await list.refetch(); }
    catch (e) { toast({ tone: 'danger', text: msg(e) }); } finally { setBusyId(null); }
  }

  const value = (c: Coupon) => (c.kind === 'percent' ? `${c.value / 100}%` : money(c.value));
  const columns: Column<Coupon>[] = [
    { key: 'code', header: t('commerce.coupons.code'), cell: (c) => <span dir="ltr" className="font-mono font-semibold">{c.code}</span> },
    { key: 'value', header: t('commerce.coupons.value'), cell: (c) => <span dir="ltr">{value(c)}</span> },
    { key: 'applies', header: t('commerce.coupons.applies_to'), className: 'hidden sm:table-cell', cell: (c) => t(`commerce.coupons.applies.${c.applies_to}`) },
    { key: 'used', header: t('commerce.coupons.used'), cell: (c) => `${c.redemptions_count} / ${c.max_redemptions ?? t('commerce.coupons.unlimited')}` },
    { key: 'window', header: t('commerce.coupons.window'), className: 'hidden md:table-cell', cell: (c) => (c.starts_at || c.ends_at ? `${c.starts_at ? when(c.starts_at) : '…'} — ${c.ends_at ? when(c.ends_at) : '…'}` : t('commerce.coupons.always')) },
    {
      key: 'status', header: t('fields.status'), cell: (c) => (
        <span className="flex items-center gap-2">
          <Badge tone={c.is_active ? 'ok' : 'neutral'}>{c.is_active ? t('commerce.coupons.active') : t('commerce.coupons.inactive')}</Badge>
          {!access.readOnly ? <Button size="sm" variant="ghost" loading={busyId === c.id} onClick={(e) => { e.stopPropagation(); toggle(c); }}>{c.is_active ? t('commerce.coupons.deactivate') : t('commerce.coupons.activate')}</Button> : null}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-3 flex justify-end">{!access.readOnly ? <Button icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>{t('commerce.coupons.new')}</Button> : null}</div>
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
        <EmptyState icon={<TicketPercent className="size-8" aria-hidden />} title={t('commerce.coupons.empty')} hint={t('commerce.coupons.empty_hint')} />
      ) : <DataTable rows={list.data} columns={columns} rowKey={(c) => c.id} caption={t('commerce.coupons.title')} />}
      {open ? <CouponDrawer onClose={() => setOpen(false)} onCreated={() => { setOpen(false); list.refetch(); toast({ tone: 'ok', text: t('commerce.coupons.created') }); }} /> : null}
    </div>
  );
}

function toIso(local: string) {
  return local ? new Date(local).toISOString() : null;
}

function CouponDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [f, setF] = useState({ code: '', kind: 'percent' as 'percent' | 'fixed', percent: '10', fixed: null as number | null, applies_to: 'all', min: 0 as number | null, max: '', per: '1', starts: '', ends: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  async function save() {
    setBusy(true); setErr(null);
    try {
      const value = f.kind === 'percent' ? Math.round((parseNum(f.percent) ?? 0) * 100) : (f.fixed ?? 0);
      await api(access.api('/coupons'), {
        body: {
          code: f.code.trim(), kind: f.kind, value, applies_to: f.applies_to, min_subtotal_minor: f.min ?? 0,
          max_redemptions: f.max ? Math.trunc(parseNum(f.max) ?? 0) : null, per_customer_limit: Math.trunc(parseNum(f.per) ?? 1),
          starts_at: toIso(f.starts), ends_at: toIso(f.ends),
        },
      });
      onCreated();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const issues = err instanceof ApiError && err.code === 'validation_failed' ? (err.details?.issues as Array<{ path: string; message: string }>) : undefined;

  return (
    <Drawer open onClose={onClose} title={t('commerce.coupons.new')} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} onClick={save}>{t('actions.create')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
        <Field label={t('commerce.coupons.code')} required hint="A-Z 0-9 - _">{(p) => <Input {...p} dir="ltr" className="font-mono uppercase" maxLength={40} value={f.code} onChange={(e) => set({ code: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('commerce.coupons.kind')}>{(p) => (
            <Select {...p} value={f.kind} onChange={(e) => set({ kind: e.target.value as 'percent' | 'fixed' })}>
              <option value="percent">{t('commerce.coupons.percent')}</option>
              <option value="fixed">{t('commerce.coupons.fixed')}</option>
            </Select>
          )}</Field>
          {f.kind === 'percent'
            ? <Field label={t('commerce.coupons.value_percent')} required>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={f.percent} onChange={(e) => set({ percent: e.target.value })} />}</Field>
            : <Field label={t('commerce.coupons.value_fixed')} required>{(p) => <MoneyInput {...p} value={f.fixed} onChange={(m) => set({ fixed: m })} />}</Field>}
        </div>
        <Field label={t('commerce.coupons.applies_to')}>{(p) => (
          <Select {...p} value={f.applies_to} onChange={(e) => set({ applies_to: e.target.value })}>
            {(['all', 'services', 'products'] as const).map((a) => <option key={a} value={a}>{t(`commerce.coupons.applies.${a}`)}</option>)}
          </Select>
        )}</Field>
        <Field label={t('commerce.coupons.min_subtotal')}>{(p) => <MoneyInput {...p} value={f.min} onChange={(m) => set({ min: m })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('commerce.coupons.max_redemptions')}>{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={f.max} onChange={(e) => set({ max: e.target.value })} />}</Field>
          <Field label={t('commerce.coupons.per_customer')}>{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={f.per} onChange={(e) => set({ per: e.target.value })} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('commerce.coupons.starts_at')}>{(p) => <Input {...p} type="datetime-local" value={f.starts} onChange={(e) => set({ starts: e.target.value })} />}</Field>
          <Field label={t('commerce.coupons.ends_at')}>{(p) => <Input {...p} type="datetime-local" value={f.ends} onChange={(e) => set({ ends: e.target.value })} />}</Field>
        </div>
      </div>
    </Drawer>
  );
}
