'use client';

import { useState } from 'react';
import { Save, Users } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, Input, MoneyInput } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';

type PayProfile = {
  staff_id: string; display_name: string; title_ar: string | null; title_en: string | null; is_active: boolean;
  base_salary_minor: number; employment_start: string | null; employment_end: string | null;
};

/** Monthly base salary and employment dates per staff member (the salary is pro-rated by days employed). */
export function SalariesTab() {
  const { t } = useI18n();
  const access = useAccess();
  const list = useApiQuery<PayProfile[]>(['payroll-salaries', access.slug], access.api('/payroll/salaries'));
  return (
    <Card title={t('payroll.salaries.title')}>
      <p className="mb-3 text-xs text-ink-muted">{t('payroll.salaries.hint')}</p>
      {list.isLoading ? <LoadingState rows={3} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
        <EmptyState icon={<Users className="size-8" aria-hidden />} title={t('payroll.salaries.empty')} />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {list.data.map((p) => <SalaryRow key={`${p.staff_id}:${p.base_salary_minor}:${p.employment_start}:${p.employment_end}`} p={p} onSaved={() => list.refetch()} />)}
        </ul>
      )}
    </Card>
  );
}

function SalaryRow({ p, onSaved }: { p: PayProfile; onSaved: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const { money } = useFmt();
  const canManage = access.can('payroll.manage') && !access.readOnly;
  const [value, setValue] = useState<number | null>(p.base_salary_minor);
  const [start, setStart] = useState(p.employment_start ?? '');
  const [end, setEnd] = useState(p.employment_end ?? '');
  const dirty = (value ?? 0) !== p.base_salary_minor || start !== (p.employment_start ?? '') || end !== (p.employment_end ?? '');
  const datesOk = !start || !end || end >= start;
  const save = useApiMutation(() => api(access.api(`/payroll/salaries/${p.staff_id}`), {
    method: 'PUT', body: { base_salary_minor: value ?? 0, employment_start: start || null, employment_end: end || null },
  }), { onSuccess: () => { onSaved(); toast({ tone: 'ok', text: t('payroll.salaries.saved', { name: p.display_name }) }); } });
  return (
    <li className="flex flex-col gap-3 py-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0 lg:w-48">
        <p className="font-medium">{p.display_name} {!p.is_active ? <Badge tone="neutral">{t('fields.inactive')}</Badge> : null}</p>
        <p className="text-xs text-ink-muted">{pick(p.title_ar, p.title_en) || t('payroll.salaries.no_title')}</p>
      </div>
      {canManage ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('payroll.fields.base')} className="w-40">{(f) => <MoneyInput {...f} value={value} onChange={setValue} />}</Field>
          <Field label={t('payroll.salaries.start')} className="w-40">{(f) => <Input {...f} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label={t('payroll.salaries.end')} className="w-40" error={datesOk ? null : t('payroll.salaries.end_before_start')}>{(f) => <Input {...f} type="date" min={start || undefined} value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
          <Button size="sm" icon={<Save className="size-4" />} disabled={!dirty || !datesOk || (value ?? 0) < 0} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('actions.save')}</Button>
        </div>
      ) : (
        <div className="text-sm">
          <span dir="ltr" className="font-semibold">{money(p.base_salary_minor)}</span>
          {p.employment_start || p.employment_end ? <p className="text-xs text-ink-muted" dir="ltr">{p.employment_start ?? '…'} → {p.employment_end ?? '…'}</p> : null}
        </div>
      )}
      {save.error ? <p className="text-sm text-danger">{msg(save.error)}</p> : null}
    </li>
  );
}
