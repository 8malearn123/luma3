'use client';

import { useState } from 'react';
import { Check, RefreshCw, TimerOff, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Checkbox, Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { MonthPicker, useMonth } from '../payroll/common';
import { useDay, useDays } from './common';

type Suggestion = {
  id: string; staff_id: string; staff_name: string; source: 'lateness' | 'absence' | 'unpaid_leave'; on_date: string; minutes: number | null; days: number | null;
  amount_minor: number; basis: { day_value_minor?: number; scheduled_minutes?: number; grace_minutes?: number }; status: 'pending' | 'approved' | 'rejected'; decision_note: string | null;
};

/** Payroll → Deduction suggestions (lateness, absence, unpaid leave): approve or reject before closing the month. */
export function SuggestionsTab() {
  const { t } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const { money } = useFmt();
  const day = useDay();
  const days = useDays();
  const [month, setMonth] = useMonth();
  const [status, setStatus] = useState<string>('pending');
  const [picked, setPicked] = useState<string[]>([]);
  const canManage = access.can('payroll.manage') && !access.readOnly;
  const q = useApiQuery<Suggestion[]>(['payroll-suggestions', access.slug, month, status], access.api(`/payroll/suggestions?month=${month}${status ? `&status=${status}` : ''}`));
  const decide = useApiMutation((v: { ids: string[]; decision: 'approved' | 'rejected' }) => api<{ decided: number }>(access.api('/payroll/suggestions'), { body: v }), {
    invalidate: [['payroll-suggestions', access.slug], ['payroll-sheet', access.slug], ['payroll-entries', access.slug]],
    onSuccess: (r, v) => { setPicked([]); toast({ tone: 'ok', text: t(v.decision === 'approved' ? 'hr.suggestions.approved_n' : 'hr.suggestions.rejected_n', { n: r.decided }) }); },
  });
  const scan = useApiMutation(() => api<{ created: number }>(access.api('/payroll/suggestions/scan'), { body: { month } }), {
    invalidate: [['payroll-suggestions', access.slug], ['payroll-sheet', access.slug]], onSuccess: (r) => toast({ tone: 'ok', text: t('hr.suggestions.scanned', { n: r.created }) }),
  });
  const rows = q.data ?? [];
  const pending = rows.filter((r) => r.status === 'pending');
  const toggle = (id: string, on: boolean) => setPicked(on ? [...picked, id] : picked.filter((x) => x !== id));
  const describe = (r: Suggestion) => (r.source === 'lateness' ? t('hr.attendance.late', { n: r.minutes ?? 0 }) : r.source === 'absence' ? t('hr.attendance.absent') : t('hr.suggestions.unpaid_days', { n: days(r.days) }));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <MonthPicker value={month} onChange={(m) => { setMonth(m); setPicked([]); }} />
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label={t('fields.status')} className="w-40" value={status} onChange={(e) => { setStatus(e.target.value); setPicked([]); }}>
            <option value="pending">{t('hr.suggestions.status.pending')}</option>
            <option value="approved">{t('hr.suggestions.status.approved')}</option>
            <option value="rejected">{t('hr.suggestions.status.rejected')}</option>
            <option value="">{t('hr.requests.all_statuses')}</option>
          </Select>
          {canManage ? <Button variant="outline" icon={<RefreshCw className="size-4" />} loading={scan.isPending} onClick={() => scan.mutate(undefined)}>{t('hr.suggestions.scan')}</Button> : null}
        </div>
      </div>
      <Alert tone="info">{t('hr.suggestions.how')}</Alert>
      {decide.error || scan.error ? <Alert tone="danger">{msg(decide.error ?? scan.error)}</Alert> : null}
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !rows.length ? (
        <EmptyState icon={<TimerOff className="size-8" aria-hidden />} title={t('hr.suggestions.empty')} />
      ) : (
        <Card>
          {canManage && pending.length ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Checkbox label={t('hr.suggestions.select_all')} checked={picked.length === pending.length} onChange={(v) => setPicked(v ? pending.map((r) => r.id) : [])} />
              <Button size="sm" icon={<Check className="size-4" />} disabled={!picked.length} loading={decide.isPending && decide.variables?.decision === 'approved'} onClick={() => decide.mutate({ ids: picked, decision: 'approved' })}>{t('hr.suggestions.approve_n', { n: picked.length })}</Button>
              <Button size="sm" variant="outline" icon={<X className="size-4" />} disabled={!picked.length} loading={decide.isPending && decide.variables?.decision === 'rejected'} onClick={() => decide.mutate({ ids: picked, decision: 'rejected' })}>{t('hr.suggestions.reject_n', { n: picked.length })}</Button>
            </div>
          ) : null}
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                {canManage && r.status === 'pending' ? <input type="checkbox" aria-label={t('hr.suggestions.select', { name: r.staff_name })} className="size-4 accent-luma-700" checked={picked.includes(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} /> : null}
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{r.staff_name}</span>
                  <span className="ms-2 text-ink-muted">{day(r.on_date)}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-2">
                    <Badge tone={r.source === 'absence' ? 'danger' : r.source === 'lateness' ? 'warn' : 'info'}>{describe(r)}</Badge>
                    {r.basis.day_value_minor ? <span className="text-xs text-ink-muted">{t('hr.suggestions.day_value', { amount: money(r.basis.day_value_minor) })}</span> : null}
                  </span>
                </span>
                <span dir="ltr" className="font-semibold text-danger">{money(-r.amount_minor)}</span>
                {r.status !== 'pending' ? <Badge tone={r.status === 'approved' ? 'ok' : 'neutral'}>{t(`hr.suggestions.status.${r.status}`)}</Badge> : canManage ? (
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => decide.mutate({ ids: [r.id], decision: 'approved' })}>{t('hr.requests.approve')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => decide.mutate({ ids: [r.id], decision: 'rejected' })}>{t('hr.requests.reject')}</Button>
                  </span>
                ) : <Badge tone="warn">{t('hr.suggestions.status.pending')}</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
