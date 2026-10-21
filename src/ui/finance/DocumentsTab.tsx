'use client';

import { useState } from 'react';
import { Download, FileText, Printer, RotateCcw } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Select } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { DataTable, type Column } from '../components/layout';
import { ConfirmDialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';

type Invoice = { id: string; number: string; kind: 'receipt' | 'invoice' | 'credit_note'; total_minor: number; currency: string; issued_at: string; booking_id: string | null; order_id: string | null };

export function DocumentsTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const list = useApiQuery<Invoice[]>(['fin-invoices', access.slug], access.api('/finance/invoices'));
  const [kind, setKind] = useState('all');
  const rows = (list.data ?? []).filter((i) => kind === 'all' || i.kind === kind);
  const doc = (id: string, html?: boolean) => access.api(`/finance/invoices/${id}/pdf${html ? '?format=html' : ''}`);
  const cols: Column<Invoice>[] = [
    { key: 'number', header: t('fe.documents.number'), cell: (i) => <span dir="ltr" className="font-mono font-medium">{i.number}</span> },
    { key: 'kind', header: t('fe.documents.kind'), cell: (i) => <Badge tone={i.kind === 'invoice' ? 'info' : i.kind === 'credit_note' ? 'warn' : 'neutral'}>{t(`fe.documents.kinds.${i.kind}`)}</Badge> },
    { key: 'for', header: t('fe.documents.for'), className: 'hidden md:table-cell', cell: (i) => <span className="text-xs">{i.booking_id ? t('fe.documents.for_booking') : i.order_id ? t('fe.documents.for_order') : '—'}</span> },
    { key: 'total', header: t('fields.total'), cell: (i) => <span dir="ltr">{money(i.total_minor)}</span> },
    { key: 'date', header: t('fields.date'), className: 'hidden sm:table-cell', cell: (i) => <span className="text-xs">{when(i.issued_at)}</span> },
    {
      key: 'open', header: <span className="sr-only">{t('actions.view')}</span>, cell: (i) => (
        <span className="flex gap-1">
          <a href={doc(i.id, true)} target="_blank" rel="noreferrer" className="inline-flex size-9 items-center justify-center rounded-lg text-luma-800 hover:bg-luma-100" aria-label={`${t('finance.print')} ${i.number}`} title={t('finance.print')}><Printer className="size-4" /></a>
          <a href={doc(i.id)} className="inline-flex size-9 items-center justify-center rounded-lg text-luma-800 hover:bg-luma-100" aria-label={`${t('finance.download_pdf')} ${i.number}`} title={t('finance.download_pdf')}><Download className="size-4" /></a>
        </span>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select aria-label={t('fe.documents.kind')} className="sm:w-48" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">{t('fe.documents.all')}</option>
          {(['receipt', 'invoice', 'credit_note'] as const).map((k) => <option key={k} value={k}>{t(`fe.documents.kinds.${k}`)}</option>)}
        </Select>
        <p className="text-xs text-ink-muted">{t('fe.documents.issue_hint')}</p>
      </div>
      {list.isLoading ? <LoadingState rows={4} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? (
        <EmptyState icon={<FileText className="size-8" aria-hidden />} title={t('fe.documents.empty')} hint={t('fe.documents.empty_hint')} />
      ) : <DataTable rows={rows} columns={cols} rowKey={(i) => i.id} caption={t('finance.tabs.documents')} />}
      <p className="text-xs text-ink-muted">{t('fe.documents.compliance')}</p>
    </div>
  );
}

type Refund = { id: string; amount_minor: number; status: string; reason: string | null; requested_by_system: boolean; created_at: string; completed_at: string | null; booking_id: string | null; order_id: string | null; method: string };

export function RefundsTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const list = useApiQuery<Refund[]>(['fin-refunds', access.slug], access.api('/refunds'));
  const [approving, setApproving] = useState<Refund | null>(null);
  const canApprove = access.can('refunds.approve') && !access.readOnly;
  const approve = useApiMutation<string>((id) => api(access.api(`/refunds/${id}/approve`), { body: {} }), {
    onSuccess: () => { setApproving(null); list.refetch(); toast({ tone: 'ok', text: t('fe.refunds.approved') }); },
  });
  const tone = (s: string) => (s === 'succeeded' ? 'ok' : s === 'failed' ? 'danger' : s === 'cancelled' ? 'neutral' : 'warn');
  const cols: Column<Refund>[] = [
    { key: 'date', header: t('fields.date'), cell: (r) => <span className="whitespace-nowrap text-xs">{when(r.created_at)}</span> },
    { key: 'amount', header: t('fe.common.amount'), cell: (r) => <span dir="ltr" className="font-medium">{money(r.amount_minor)}</span> },
    { key: 'method', header: t('fe.refunds.method'), className: 'hidden sm:table-cell', cell: (r) => t(`fe.methods.${r.method}`) },
    { key: 'reason', header: t('fields.reason'), className: 'hidden md:table-cell', cell: (r) => <span className="text-xs">{r.requested_by_system ? t('fe.refunds.by_policy') : r.reason ?? '—'}</span> },
    {
      key: 'status', header: t('fields.status'), cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={tone(r.status)}>{t(`fe.refunds.status.${r.status}`)}</Badge>
          {canApprove && r.status === 'requested' ? <Button size="sm" variant="outline" onClick={() => setApproving(r)}>{t('finance.approve')}</Button> : null}
        </span>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-muted">{t('fe.refunds.intro')}</p>
      {list.isLoading ? <LoadingState rows={3} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
        <EmptyState icon={<RotateCcw className="size-8" aria-hidden />} title={t('fe.refunds.empty')} />
      ) : <DataTable rows={list.data} columns={cols} rowKey={(r) => r.id} caption={t('finance.tabs.refunds')} />}
      <ConfirmDialog open={!!approving} onClose={() => setApproving(null)} loading={approve.isPending} title={t('fe.refunds.approve_title')}
        body={<>{approving ? t('fe.refunds.approve_body', { amount: money(approving.amount_minor) }) : null}{approve.error ? <p className="mt-2 text-danger">{msg(approve.error)}</p> : null}</>}
        confirmLabel={t('finance.approve')} onConfirm={() => approving && approve.mutate(approving.id)} />
    </div>
  );
}
