'use client';

import { useState } from 'react';
import { DateTime } from 'luxon';
import { ImageIcon, Plus, Wallet } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { DataTable, type Column } from '../components/layout';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { ImageUpload } from '../workspace/ImageUpload';
import { ReasonDialog } from '../engagement/shared';
import { PeriodPicker, usePeriod } from './common';

type Expense = { id: string; category: string; amount_minor: number; incurred_on: string; description: string | null; receipt_asset_id: string | null; voided_at: string | null; void_reason: string | null };
const CATEGORIES = ['rent', 'salaries', 'supplies', 'marketing', 'utilities', 'equipment', 'fees', 'other'] as const;

export function ExpensesTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const toast = useToast();
  const { period, setPeriod, valid } = usePeriod('this_month');
  const key = ['fin-expenses', access.slug, period.from, period.to];
  const list = useApiQuery<Expense[]>(key, valid ? access.api(`/finance/expenses?from=${period.from}&to=${period.to}`) : null);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<Expense | null>(null);
  const canManage = access.can('finance.manage') && !access.readOnly;
  const active = (list.data ?? []).filter((e) => !e.voided_at);
  const total = active.reduce((a, e) => a + e.amount_minor, 0);

  const columns: Column<Expense>[] = [
    { key: 'date', header: t('finance.incurred_on'), cell: (e) => <span dir="ltr" className="whitespace-nowrap text-xs">{e.incurred_on}</span> },
    { key: 'cat', header: t('finance.category'), cell: (e) => <div><p className={e.voided_at ? 'line-through text-ink-muted' : ''}>{t(`finance.categories.${e.category}`)}</p>{e.description ? <p className="max-w-56 truncate text-xs text-ink-muted">{e.description}</p> : null}</div> },
    { key: 'amount', header: t('fe.common.amount'), cell: (e) => <span dir="ltr" className={e.voided_at ? 'line-through text-ink-muted' : 'font-medium'}>{money(e.amount_minor)}</span> },
    {
      key: 'receipt', header: t('fe.expenses.receipt'), className: 'hidden sm:table-cell', cell: (e) => e.receipt_asset_id
        ? <a href={`/api/v1/media/${e.receipt_asset_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-luma-700 hover:underline"><ImageIcon className="size-4" aria-hidden />{t('actions.view')}</a>
        : <span className="text-xs text-ink-muted">{t('fe.expenses.no_receipt')}</span>,
    },
    {
      key: 'status', header: t('fields.status'), cell: (e) => e.voided_at
        ? <span className="flex flex-col gap-0.5"><Badge tone="neutral">{t('finance.voided')}</Badge>{e.void_reason ? <span className="max-w-40 truncate text-[11px] text-ink-muted">{e.void_reason}</span> : null}</span>
        : canManage ? <Button size="sm" variant="ghost" className="text-danger" onClick={() => setVoiding(e)}>{t('finance.void')}</Button> : <Badge tone="ok">{t('fe.expenses.recorded')}</Badge>,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <PeriodPicker value={period} onChange={setPeriod} />
        {canManage ? <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t('finance.add_expense')}</Button> : null}
      </div>
      {!valid ? <Alert tone="warn">{t('fe.period.invalid')}</Alert> : list.isLoading ? <LoadingState rows={4} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
        <EmptyState icon={<Wallet className="size-8" aria-hidden />} title={t('fe.expenses.empty')} hint={canManage ? t('fe.expenses.empty_hint') : undefined} />
      ) : (
        <>
          <p className="text-sm text-ink-muted">{t('fe.expenses.total', { n: active.length })}: <span dir="ltr" className="font-semibold text-ink">{money(total)}</span></p>
          <DataTable rows={list.data} columns={columns} rowKey={(e) => e.id} caption={t('finance.expenses')} />
          <p className="text-xs text-ink-muted">{t('fe.expenses.void_note')}</p>
        </>
      )}
      {adding ? <ExpenseDrawer onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.refetch(); toast({ tone: 'ok', text: t('fe.expenses.saved') }); }} /> : null}
      <ReasonDialog open={!!voiding} onClose={() => setVoiding(null)} title={t('fe.expenses.void_title')} confirmLabel={t('finance.void')}
        body={voiding ? t('fe.expenses.void_body', { amount: money(voiding.amount_minor), category: t(`finance.categories.${voiding.category}`) }) : null}
        onConfirm={async (reason) => {
          await api(access.api(`/finance/expenses/${voiding!.id}/void`), { body: { reason } });
          setVoiding(null); await list.refetch(); toast({ tone: 'ok', text: t('fe.expenses.voided') });
        }} />
    </div>
  );
}

function ExpenseDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { money } = useFmt();
  const today = DateTime.now().setZone(access.timezone).toISODate()!;
  const [f, setF] = useState({ category: 'supplies', amount: null as number | null, date: today, description: '', receipt: null as string | null });
  const [confirm, setConfirm] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const dirty = f.amount != null || !!f.description || !!f.receipt;
  useUnsavedChangesWarning(dirty);
  const save = useApiMutation<void, unknown>(() => api(access.api('/finance/expenses'), {
    body: { category: f.category, amount_minor: f.amount!, incurred_on: f.date, description: f.description.trim() || undefined, receipt_asset_id: f.receipt },
  }), { onSuccess: onSaved });
  const err = save.error;
  const issues = err instanceof ApiError && err.code === 'validation_failed' ? (err.details?.issues as Array<{ path: string; message: string }>) : undefined;
  const ok = (f.amount ?? 0) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(f.date);

  return (
    <Drawer open onClose={onClose} title={t('finance.add_expense')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button disabled={!ok} loading={save.isPending} onClick={() => setConfirm(true)}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
        <Field label={t('finance.category')} required>{(p) => (
          <Select {...p} value={f.category} onChange={(e) => set({ category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`finance.categories.${c}`)}</option>)}
          </Select>
        )}</Field>
        <Field label={t('fe.common.amount')} required>{(p) => <MoneyInput {...p} value={f.amount} onChange={(m) => set({ amount: m })} />}</Field>
        <Field label={t('finance.incurred_on')} required>{(p) => <Input {...p} type="date" max={today} value={f.date} onChange={(e) => set({ date: e.target.value })} />}</Field>
        <Field label={t('fields.notes')} hint={t('fields.optional')}>{(p) => <Textarea {...p} maxLength={500} value={f.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
        <ImageUpload slug={access.slug} purpose="receipt" value={f.receipt} onChange={(id) => set({ receipt: id })} label={t('fe.expenses.attach_receipt')} />
        <p className="text-xs text-ink-muted">{t('fe.expenses.receipt_private')}</p>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} loading={save.isPending} title={t('fe.expenses.confirm_title')}
        body={t('fe.expenses.confirm_body', { amount: money(f.amount ?? 0), category: t(`finance.categories.${f.category}`), date: f.date })}
        onConfirm={() => { setConfirm(false); save.mutate(); }} />
    </Drawer>
  );
}
