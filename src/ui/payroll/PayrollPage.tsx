'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FileText, Lock, Users, Wallet } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, DataTable, PageHeader, Stat, Tabs, type Column } from '../components/layout';
import { ConfirmDialog, Dialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { MonthPicker, percent, useMonth, useMonthLabel, type Sheet, type SheetRow } from './common';
import { EntriesTab } from './EntriesTab';
import { SalariesTab } from './SalariesTab';
import { CommissionTab } from './CommissionTab';

const TABS = ['sheet', 'entries', 'salaries', 'commission'] as const;
type Tab = (typeof TABS)[number];

export function PayrollPage() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const raw = sp.get('tab') as Tab | null;
  const tab: Tab = raw && TABS.includes(raw) ? raw : 'sheet';
  const setTab = (v: Tab) => {
    const u = new URLSearchParams(sp.toString());
    if (v === 'sheet') u.delete('tab'); else u.set('tab', v);
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  };
  return (
    <div>
      <PageHeader title={t('payroll.title')} subtitle={t('payroll.subtitle')} />
      <Tabs value={tab} onChange={setTab} items={TABS.map((k) => ({ value: k, label: t(`payroll.tabs.${k}`) }))} />
      {tab === 'sheet' ? <SheetTab /> : null}
      {tab === 'entries' ? <EntriesTab /> : null}
      {tab === 'salaries' ? <SalariesTab /> : null}
      {tab === 'commission' ? <CommissionTab /> : null}
    </div>
  );
}

function SheetTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const monthLabel = useMonthLabel();
  const [month, setMonth] = useMonth();
  const canManage = access.can('payroll.manage') && !access.readOnly;
  const q = useApiQuery<Sheet>(['payroll-sheet', access.slug, month], access.api(`/payroll/sheet?month=${month}`));
  const [confirmClose, setConfirmClose] = useState(false);
  const [paying, setPaying] = useState<SheetRow | null>(null);
  const close = useApiMutation(() => api(access.api('/payroll/close'), { body: { month } }), {
    onSuccess: () => { setConfirmClose(false); q.refetch(); toast({ tone: 'ok', text: t('payroll.sheet.closed_ok', { month: monthLabel(month) }) }); },
  });
  const s = q.data;
  const closed = s?.status === 'closed';
  const showProducts = !!s && s.rows.some((r) => r.product_sales_minor > 0 || r.product_commission_minor > 0);
  const minus = (v: number) => (v ? <span dir="ltr" className="text-danger">{money(-v)}</span> : <span dir="ltr" className="text-ink-muted">{money(0)}</span>);

  const columns: Column<SheetRow>[] = [
    { key: 'staff', header: t('payroll.fields.staff'), cell: (r) => <div><p className="font-medium">{r.staff_name}</p>{r.number ? <p dir="ltr" className="text-xs text-ink-muted">{r.number}</p> : null}</div> },
    {
      key: 'base', header: t('payroll.fields.base'), className: 'hidden md:table-cell', cell: (r) => (
        <div><span dir="ltr">{money(r.base_minor)}</span>
          {r.days_employed && r.days_employed < r.days_in_month ? <p className="text-[11px] text-ink-muted">{t('payroll.sheet.prorated', { d: r.days_employed, n: r.days_in_month })}</p> : null}</div>
      ),
    },
    {
      key: 'services', header: t('payroll.fields.service_commission'), cell: (r) => (
        <div><span dir="ltr">{money(r.service_commission_minor)}</span>
          <p className="text-[11px] text-ink-muted">{t('payroll.sheet.sales_at', { sales: money(r.service_sales_minor), pct: percent(r.service_rate_bp) })}</p></div>
      ),
    },
    ...(showProducts ? [{
      key: 'products', header: t('payroll.fields.product_commission'), className: 'hidden md:table-cell', cell: (r: SheetRow) => (
        <div><span dir="ltr">{money(r.product_commission_minor)}</span>
          <p className="text-[11px] text-ink-muted">{t('payroll.sheet.sales_at', { sales: money(r.product_sales_minor), pct: percent(r.product_rate_bp) })}</p></div>
      ),
    }] : []),
    { key: 'tips', header: t('payroll.fields.tips'), className: 'hidden md:table-cell', cell: (r) => <span dir="ltr">{money(r.tips_minor)}</span> },
    { key: 'bonus', header: t('payroll.fields.bonus'), className: 'hidden lg:table-cell', cell: (r) => <span dir="ltr">{money(r.bonus_minor)}</span> },
    { key: 'deduction', header: t('payroll.fields.deduction'), className: 'hidden lg:table-cell', cell: (r) => minus(r.deduction_minor) },
    { key: 'advance', header: t('payroll.fields.advance'), className: 'hidden lg:table-cell', cell: (r) => minus(r.advance_minor) },
    { key: 'net', header: t('payroll.fields.net'), cell: (r) => <span dir="ltr" className={r.net_minor < 0 ? 'font-semibold text-danger' : 'font-semibold'}>{money(r.net_minor)}</span> },
    ...(closed ? [{
      key: 'paid', header: t('fields.status'), cell: (r: SheetRow) => (
        <span className="flex flex-wrap items-center gap-2">
          {r.paid_at ? <Badge tone="ok">{t('payroll.sheet.paid')}{r.paid_method ? ` · ${t(`payroll.methods.${r.paid_method}`)}` : ''}</Badge> : r.net_minor > 0 && canManage
            ? <Button size="sm" onClick={() => setPaying(r)}>{t('payroll.sheet.pay')}</Button>
            : <Badge tone="neutral">{r.net_minor > 0 ? t('payroll.sheet.unpaid') : t('payroll.sheet.nothing_due')}</Badge>}
          {r.id ? <a href={access.api(`/payroll/slips/${r.id}`)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-luma-700 hover:underline"><FileText className="size-3.5" aria-hidden />{t('payroll.sheet.slip')}</a> : null}
        </span>
      ),
    }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <MonthPicker value={month} onChange={setMonth} />
        {s ? (
          <div className="flex flex-wrap items-center gap-2">
            {closed ? <Badge tone="ok"><Lock className="me-1 inline size-3" aria-hidden />{t('payroll.sheet.status_closed')}</Badge> : <Badge tone="info">{t('payroll.sheet.status_open')}</Badge>}
            {!closed && canManage ? <Button icon={<Lock className="size-4" />} disabled={!s.close.allowed} onClick={() => setConfirmClose(true)}>{t('payroll.sheet.close')}</Button> : null}
          </div>
        ) : null}
      </div>

      {q.isLoading ? <LoadingState rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : s ? (
        <>
          {closed && s.run ? <Alert tone="info">{t('payroll.sheet.closed_note', { when: when(s.run.closed_at) })}</Alert> : null}
          {!closed && s.close.blocker && canManage ? (
            <Alert tone="warn">{t(`payroll.blockers.${s.close.blocker}`, { month: s.close.expected_month ? monthLabel(s.close.expected_month) : '' })}</Alert>
          ) : null}
          {!closed && s.carried_from ? <Alert tone="info">{t('payroll.sheet.carried', { month: monthLabel(s.carried_from) })}</Alert> : null}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t('payroll.fields.net')} value={<span dir="ltr">{money(s.totals.net_minor)}</span>} hint={closed ? t('payroll.sheet.paid_of', { amount: money(s.totals.paid_minor) }) : undefined} />
            <Stat label={t('payroll.sheet.staff_count')} value={s.rows.length} />
            <Stat label={t('payroll.fields.commission')} value={<span dir="ltr">{money(s.totals.commission_minor)}</span>} />
            <Stat label={t('payroll.fields.tips')} value={<span dir="ltr">{money(s.totals.tips_minor)}</span>} />
          </div>
          <Card>
            {!s.rows.length ? (
              <EmptyState icon={<Users className="size-8" aria-hidden />} title={t('payroll.sheet.empty')} hint={t('payroll.sheet.empty_hint')} />
            ) : (
              <>
                <DataTable rows={s.rows} columns={columns} rowKey={(r) => r.staff_id} caption={t('payroll.tabs.sheet')} />
                <p className="mt-3 text-xs text-ink-muted">{t('payroll.sheet.formula')}</p>
              </>
            )}
          </Card>
        </>
      ) : null}

      <ConfirmDialog open={confirmClose} onClose={() => setConfirmClose(false)} loading={close.isPending} title={t('payroll.sheet.close_title', { month: monthLabel(month) })}
        body={<>{t('payroll.sheet.close_body', { n: s?.rows.length ?? 0, amount: money(s?.totals.net_minor ?? 0) })}{close.error ? <p className="mt-2 text-danger">{msg(close.error)}</p> : null}</>}
        confirmLabel={t('payroll.sheet.close')} onConfirm={() => close.mutate(undefined)} />
      {paying ? <PayDialog row={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); q.refetch(); toast({ tone: 'ok', text: t('payroll.sheet.paid_ok') }); }} /> : null}
    </div>
  );
}

function PayDialog({ row, onClose, onDone }: { row: SheetRow; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { money } = useFmt();
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState<'bank_transfer' | 'cash'>('bank_transfer');
  const m = useApiMutation(() => api(access.api(`/payroll/slips/${row.id}/pay`), { body: { method, reference: reference.trim() || undefined } }), { onSuccess: () => onDone() });
  return (
    <Dialog open onClose={onClose} title={t('payroll.sheet.pay_title', { name: row.staff_name })} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button icon={<Wallet className="size-4" />} loading={m.isPending} onClick={() => m.mutate(undefined)}>{t('payroll.sheet.pay')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={m.error ? msg(m.error) : null} />
        <p>{t('payroll.sheet.pay_body', { amount: money(row.net_minor) })}</p>
        <Field label={t('payroll.entries.payout')} required>{(p) => (
          <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'bank_transfer' | 'cash')}>
            <option value="bank_transfer">{t('payroll.methods.bank_transfer')}</option>
            <option value="cash">{t('payroll.methods.cash')}</option>
          </Select>
        )}</Field>
        <Field label={t('payroll.fields.reference')} hint={t('fields.optional')}>{(p) => <Input {...p} dir="ltr" maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}
