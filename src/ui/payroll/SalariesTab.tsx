'use client';

import { useState } from 'react';
import { Save, Users } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { MoneyInput } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';

type PayProfile = { staff_id: string; display_name: string; title_ar: string | null; title_en: string | null; is_active: boolean; base_salary_minor: number };

/** Monthly base salary per staff member. */
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
          {list.data.map((p) => <SalaryRow key={p.staff_id} p={p} onSaved={() => list.refetch()} />)}
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
  const dirty = (value ?? 0) !== p.base_salary_minor;
  const save = useApiMutation(() => api(access.api(`/payroll/salaries/${p.staff_id}`), { method: 'PUT', body: { base_salary_minor: value ?? 0 } }), {
    onSuccess: () => { onSaved(); toast({ tone: 'ok', text: t('payroll.salaries.saved', { name: p.display_name }) }); },
  });
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium">{p.display_name} {!p.is_active ? <Badge tone="neutral">{t('fields.inactive')}</Badge> : null}</p>
        <p className="text-xs text-ink-muted">{pick(p.title_ar, p.title_en) || t('payroll.salaries.no_title')}</p>
      </div>
      {canManage ? (
        <div className="flex items-center gap-2">
          <span className="w-40 shrink-0"><MoneyInput aria-label={t('payroll.fields.base')} value={value} onChange={setValue} /></span>
          <Button size="sm" icon={<Save className="size-4" />} disabled={!dirty || (value ?? 0) < 0} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('actions.save')}</Button>
        </div>
      ) : <span dir="ltr" className="font-semibold">{money(p.base_salary_minor)}</span>}
      {save.error ? <p className="text-sm text-danger">{msg(save.error)}</p> : null}
    </li>
  );
}
