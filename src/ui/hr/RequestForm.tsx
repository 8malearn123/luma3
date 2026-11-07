'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select, Textarea } from '../components/form';
import { Alert, LoadingState } from '../components/feedback';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { todayIn } from '../catalog/common';
import { ChainSteps, type RequestType } from './common';
import { OwnBalanceNote } from './LeavePanels';

/** Submit any request type: leave (dates + balance), advance (amount + instalments), letters and custom fields. */
export function RequestForm({ staff, onDone, compact }: { staff?: Array<{ id: string; display_name: string; is_active: boolean }>; onDone?: () => void; compact?: boolean }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const types = useApiQuery<RequestType[]>(['hr-types', access.slug], access.api('/hr/request-types'));
  const onBehalf = !!staff && access.can('schedule.manage');
  const [typeId, setTypeId] = useState('');
  const [staffId, setStaffId] = useState(onBehalf ? '' : access.staffProfileId ?? '');
  const tomorrow = todayIn(access.timezone, 1);
  const [from, setFrom] = useState(tomorrow);
  const [to, setTo] = useState(tomorrow);
  const [amount, setAmount] = useState<number | null>(null);
  const [installments, setInstallments] = useState('1');
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  useUnsavedChangesWarning(!!note.trim() || Object.values(values).some(Boolean));
  const type = (types.data ?? []).find((x) => x.id === typeId) ?? null;
  const target = onBehalf ? staffId : access.staffProfileId;
  const n = Number(installments);
  const invalidDates = type?.kind === 'leave' && (!from || !to || to < from);
  const missing = (type?.fields ?? []).some((f) => f.required && !values[f.key]?.trim());
  const invalid = !type || !target || invalidDates || missing || (type.kind === 'advance' && (!amount || !Number.isInteger(n) || n < 1 || n > 36));
  const m = useApiMutation(() => api<{ warning: string | null }>(access.api('/hr/requests'), {
    body: {
      type_id: typeId, ...(onBehalf ? { staff_id: staffId } : {}),
      ...(type?.kind === 'leave' ? { starts_on: from, ends_on: to } : {}),
      ...(type?.kind === 'advance' ? { amount_minor: amount, installments: n } : {}),
      values: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())), ...(note.trim() ? { note: note.trim() } : {}),
    },
  }), {
    invalidate: [['hr-requests', access.slug], ['hr-balances', access.slug], ['leave', access.slug], ['portal', access.slug]],
    onSuccess: (r) => {
      toast({ tone: r.warning ? 'info' : 'ok', text: r.warning ? t('hr.request.sent_warning') : t('hr.request.sent') });
      setValues({}); setNote(''); setAmount(null); setTypeId('');
      onDone?.();
    },
  });
  if (types.isLoading) return <LoadingState rows={2} />;
  return (
    <form className={compact ? 'flex flex-col gap-3' : 'grid gap-3 sm:grid-cols-2'} onSubmit={(e) => { e.preventDefault(); if (!invalid) m.mutate(undefined); }}>
      <div className={compact ? '' : 'sm:col-span-2'}><FormErrorSummary message={m.error ? msg(m.error) : null} /></div>
      {onBehalf ? (
        <Field label={t('hr.request.staff')} required>{(p) => (
          <Select {...p} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">{t('hr.request.choose_staff')}</option>
            {staff!.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
          </Select>
        )}</Field>
      ) : null}
      <Field label={t('hr.request.type')} required>{(p) => (
        <Select {...p} value={typeId} onChange={(e) => { setTypeId(e.target.value); setValues({}); }}>
          <option value="">{t('hr.request.choose_type')}</option>
          {(types.data ?? []).map((x) => <option key={x.id} value={x.id}>{pick(x.name_ar, x.name_en)}</option>)}
        </Select>
      )}</Field>
      {type ? <p className={compact ? 'text-xs text-ink-muted' : 'self-end text-xs text-ink-muted sm:col-span-2'}>{t('hr.request.chain')}: <ChainSteps chain={type.approval_chain} /></p> : null}
      {type?.kind === 'leave' ? (
        <>
          <div className={compact ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-2 gap-2 sm:col-span-2'}>
            <Field label={t('hr.request.from')} required>{(p) => <Input {...p} type="date" dir="ltr" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} />}</Field>
            <Field label={t('hr.request.to')} required error={invalidDates ? t('hr.request.dates_invalid') : null}>{(p) => <Input {...p} type="date" dir="ltr" min={from} value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          </div>
          {type.leave_type === 'annual' && target ? <div className={compact ? '' : 'sm:col-span-2'}><OwnBalanceNote staffId={target} /></div> : null}
          {type.leave_type === 'sick' ? <p className={compact ? 'text-xs text-ink-muted' : 'text-xs text-ink-muted sm:col-span-2'}>{t('hr.request.sick_note')}</p> : null}
          {type.leave_type === 'unpaid' ? <Alert tone="warn" className={compact ? '' : 'sm:col-span-2'}>{t('hr.request.unpaid_note')}</Alert> : null}
        </>
      ) : null}
      {type?.kind === 'advance' ? (
        <>
          <Field label={t('hr.request.amount')} required>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
          <Field label={t('hr.request.installments')} hint={t('hr.request.installments_hint')} required>{(p) => <Input {...p} type="number" min={1} max={36} dir="ltr" value={installments} onChange={(e) => setInstallments(e.target.value)} />}</Field>
        </>
      ) : null}
      {(type?.fields ?? []).map((f) => (
        <Field key={f.key} label={pick(f.label_ar, f.label_en)} required={f.required}>{(p) => (
          f.type === 'select' ? (
            <Select {...p} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
              <option value="">—</option>
              {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          ) : (
            <Input {...p} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} dir={f.type === 'text' ? undefined : 'ltr'} maxLength={500}
              value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          )
        )}</Field>
      ))}
      {type ? <Field label={t('hr.request.note')} hint={t('fields.optional')} className={compact ? '' : 'sm:col-span-2'}>{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field> : null}
      <div className={compact ? 'flex gap-2' : 'flex gap-2 sm:col-span-2'}>
        <Button type="submit" loading={m.isPending} disabled={!!invalid}>{t('hr.request.submit')}</Button>
        {onDone && !compact ? <Button variant="ghost" onClick={onDone}>{t('actions.cancel')}</Button> : null}
      </div>
    </form>
  );
}
