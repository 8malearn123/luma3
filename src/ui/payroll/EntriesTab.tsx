'use client';

import { useState } from 'react';
import { DateTime } from 'luxon';
import { Plus, ReceiptText } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { DataTable, type Column } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { ReasonDialog } from '../engagement/shared';
import { KIND_TONE, MonthPicker, NEGATIVE, useMonth, useMonthLabel, type EntryKind } from './common';

type Entry = {
  id: string; staff_id: string; staff_name: string; kind: EntryKind; amount_minor: number; effective_on: string; note: string | null;
  method: 'cash' | 'pos_terminal' | null; booking_number: string | null; voided_at: string | null; void_reason: string | null; settled_in: string | null;
};
type Staff = { staff_id: string; display_name: string };
const KINDS: EntryKind[] = ['bonus', 'deduction', 'advance', 'tip'];

export function EntriesTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const toast = useToast();
  const monthLabel = useMonthLabel();
  const [month, setMonth] = useMonth();
  const canManage = access.can('payroll.manage') && !access.readOnly;
  const list = useApiQuery<Entry[]>(['payroll-entries', access.slug, month], access.api(`/payroll/entries?month=${month}`));
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<Entry | null>(null);

  const columns: Column<Entry>[] = [
    { key: 'date', header: t('fields.date'), cell: (e) => <span dir="ltr" className="whitespace-nowrap text-xs">{e.effective_on}</span> },
    { key: 'staff', header: t('payroll.fields.staff'), cell: (e) => <span className={e.voided_at ? 'text-ink-muted line-through' : 'font-medium'}>{e.staff_name}</span> },
    {
      key: 'kind', header: t('payroll.fields.kind'), cell: (e) => (
        <div>
          <Badge tone={KIND_TONE[e.kind]}>{t(`payroll.kinds.${e.kind}`)}</Badge>
          {e.note ? <p className="mt-0.5 max-w-56 truncate text-xs text-ink-muted">{e.note}</p> : null}
          {e.booking_number ? <p dir="ltr" className="text-[11px] text-ink-muted">{e.booking_number}</p> : null}
        </div>
      ),
    },
    {
      key: 'amount', header: t('payroll.fields.amount'), cell: (e) => (
        <span dir="ltr" className={e.voided_at ? 'text-ink-muted line-through' : NEGATIVE.includes(e.kind) ? 'font-medium text-danger' : 'font-medium'}>
          {money(NEGATIVE.includes(e.kind) ? -e.amount_minor : e.amount_minor)}
        </span>
      ),
    },
    {
      key: 'status', header: t('fields.status'), cell: (e) => e.voided_at
        ? <span className="flex flex-col gap-0.5"><Badge tone="neutral">{t('finance.voided')}</Badge>{e.void_reason ? <span className="max-w-40 truncate text-[11px] text-ink-muted">{e.void_reason}</span> : null}</span>
        : e.settled_in ? <Badge tone="ok">{t('payroll.entries.settled_in', { month: monthLabel(e.settled_in) })}</Badge>
          : canManage ? <Button size="sm" variant="ghost" className="text-danger" onClick={() => setVoiding(e)}>{t('finance.void')}</Button>
            : <Badge tone="info">{t('payroll.entries.pending')}</Badge>,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <MonthPicker value={month} onChange={setMonth} />
        {canManage ? <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t('payroll.entries.add')}</Button> : null}
      </div>
      {list.isLoading ? <LoadingState rows={4} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
        <EmptyState icon={<ReceiptText className="size-8" aria-hidden />} title={t('payroll.entries.empty')} hint={t('payroll.entries.empty_hint')} />
      ) : (
        <>
          <DataTable rows={list.data} columns={columns} rowKey={(e) => e.id} caption={t('payroll.tabs.entries')} />
          <p className="text-xs text-ink-muted">{t('payroll.entries.note')}</p>
        </>
      )}
      {adding ? <EntryDrawer onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.refetch(); toast({ tone: 'ok', text: t('payroll.entries.saved') }); }} /> : null}
      <ReasonDialog open={!!voiding} onClose={() => setVoiding(null)} title={t('payroll.entries.void_title')} confirmLabel={t('finance.void')}
        body={voiding ? t('payroll.entries.void_body', { kind: t(`payroll.kinds.${voiding.kind}`), amount: money(voiding.amount_minor), name: voiding.staff_name }) : null}
        onConfirm={async (reason) => {
          await api(access.api(`/payroll/entries/${voiding!.id}/void`), { body: { reason } });
          setVoiding(null); await list.refetch(); toast({ tone: 'ok', text: t('payroll.entries.voided') });
        }} />
    </div>
  );
}

function EntryDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const staff = useApiQuery<Staff[]>(['payroll-salaries', access.slug], access.api('/payroll/salaries'));
  const today = DateTime.now().setZone(access.timezone).toISODate()!;
  const [f, setF] = useState({ staff_id: '', kind: 'bonus' as EntryKind, amount: null as number | null, date: today, note: '', method: 'cash' as 'cash' | 'pos_terminal' });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  useUnsavedChangesWarning(f.amount != null || !!f.note);
  const save = useApiMutation(() => api(access.api('/payroll/entries'), {
    body: { staff_id: f.staff_id, kind: f.kind, amount_minor: f.amount, effective_on: f.date, note: f.note.trim() || undefined, ...(f.kind === 'tip' ? { method: f.method } : {}) },
  }), { onSuccess: () => onSaved() });
  const issues = save.error instanceof ApiError && save.error.code === 'validation_failed' ? (save.error.details?.issues as Array<{ path: string; message: string }>) : undefined;
  const ok = !!f.staff_id && (f.amount ?? 0) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(f.date);
  return (
    <Drawer open onClose={onClose} title={t('payroll.entries.add')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button disabled={!ok} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={save.error ? msg(save.error) : null} issues={issues} />
        <Field label={t('payroll.fields.staff')} required>{(p) => (
          <Select {...p} value={f.staff_id} onChange={(e) => set({ staff_id: e.target.value })}>
            <option value="">{t('payroll.entries.choose_staff')}</option>
            {(staff.data ?? []).map((s) => <option key={s.staff_id} value={s.staff_id}>{s.display_name}</option>)}
          </Select>
        )}</Field>
        <Field label={t('payroll.fields.kind')} required hint={t(`payroll.kind_hints.${f.kind}`)}>{(p) => (
          <Select {...p} value={f.kind} onChange={(e) => set({ kind: e.target.value as EntryKind })}>
            {KINDS.map((k) => <option key={k} value={k}>{t(`payroll.kinds.${k}`)}</option>)}
          </Select>
        )}</Field>
        <Field label={t('payroll.fields.amount')} required>{(p) => <MoneyInput {...p} value={f.amount} onChange={(m) => set({ amount: m })} />}</Field>
        {f.kind === 'tip' ? (
          <Field label={t('booking.dashboard.method')} required>{(p) => (
            <Select {...p} value={f.method} onChange={(e) => set({ method: e.target.value as 'cash' | 'pos_terminal' })}>
              <option value="cash">{t('booking.dashboard.cash')}</option>
              <option value="pos_terminal">{t('booking.dashboard.pos')}</option>
            </Select>
          )}</Field>
        ) : null}
        <Field label={t('fields.date')} required hint={t('payroll.entries.date_hint')}>{(p) => <Input {...p} type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} />}</Field>
        <Field label={t('fields.notes')} hint={t('fields.optional')}>{(p) => <Input {...p} maxLength={500} value={f.note} onChange={(e) => set({ note: e.target.value })} />}</Field>
      </div>
    </Drawer>
  );
}
