'use client';

import { useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, DataTable, type Column } from '../components/layout';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { useStepUp } from '../policy/StepUp';
import { PeriodPicker, usePeriod } from './common';

type Exp = { id: string; kind: string; period_start: string; period_end: string; status: string; row_count: number | null; error: string | null; created_at: string; download_url: string | null };
const KINDS = ['bookings', 'payments', 'journal', 'expenses'] as const;

export function ExportsTab() {
  const { t } = useI18n();
  const access = useAccess();
  const { when } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const stepUp = useStepUp();
  const canExport = access.can('finance.export') && !access.readOnly;
  const list = useApiQuery<Exp[]>(['fin-exports', access.slug], access.api('/finance/exports'));
  const { period, setPeriod, valid } = usePeriod('last_month');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('bookings');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ready, setReady] = useState<{ url: string; rows: number } | null>(null);

  async function create() {
    setBusy(true); setErr(null); setReady(null);
    try {
      const r = await stepUp(() => api<{ download_url: string; row_count: number }>(access.api('/finance/exports'), { body: { kind, from: period.from, to: period.to } }));
      setReady({ url: r.download_url, rows: r.row_count });
      toast({ tone: 'ok', text: t('finance.export_ready') });
      list.refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const cols: Column<Exp>[] = [
    { key: 'kind', header: t('fe.exports.kind'), cell: (e) => t(`finance.export_kinds.${e.kind}`) },
    { key: 'period', header: t('finance.period'), cell: (e) => <span dir="ltr" className="whitespace-nowrap text-xs">{e.period_start} → {e.period_end}</span> },
    { key: 'rows', header: t('fe.exports.rows'), className: 'hidden sm:table-cell', cell: (e) => e.row_count ?? '—' },
    { key: 'created', header: t('fe.exports.created'), className: 'hidden md:table-cell', cell: (e) => <span className="text-xs">{when(e.created_at)}</span> },
    {
      key: 'status', header: t('fields.status'), cell: (e) => e.status === 'succeeded' && e.download_url && access.can('finance.export')
        ? <a href={e.download_url} className="inline-flex items-center gap-1 text-luma-700 hover:underline"><Download className="size-4" aria-hidden />{t('fe.exports.download')}</a>
        : <Badge tone={e.status === 'failed' ? 'danger' : e.status === 'succeeded' ? 'ok' : 'warn'}>{t(`fe.exports.status.${e.status}`)}</Badge>,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {canExport ? (
        <Card title={t('finance.export')}>
          <div className="flex flex-col gap-3">
            <FormErrorSummary message={err && !(err instanceof Error && err.message === 'cancelled') ? msg(err) : null} />
            <Field label={t('fe.exports.kind')} className="sm:w-60">{(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
                {KINDS.map((k) => <option key={k} value={k}>{t(`finance.export_kinds.${k}`)}</option>)}
              </Select>
            )}</Field>
            <PeriodPicker value={period} onChange={setPeriod} />
            {!valid ? <Alert tone="warn">{t('fe.period.invalid')}</Alert> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button icon={<FileSpreadsheet className="size-4" />} loading={busy} disabled={!valid} onClick={create}>{t('finance.export')}</Button>
              {ready ? <a href={ready.url} className="inline-flex items-center gap-1 text-sm font-medium text-luma-700 hover:underline"><Download className="size-4" aria-hidden />{t('fe.exports.download')} ({t('fe.exports.rows_n', { n: ready.rows })})</a> : null}
            </div>
            <p className="text-xs text-ink-muted">{t('fe.exports.note')}</p>
          </div>
        </Card>
      ) : <Alert tone="info">{t('fe.exports.no_permission')}</Alert>}
      <Card title={t('fe.exports.history')}>
        {list.isLoading ? <LoadingState rows={3} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
          <EmptyState icon={<FileSpreadsheet className="size-8" aria-hidden />} title={t('fe.exports.empty')} />
        ) : <DataTable rows={list.data} columns={cols} rowKey={(e) => e.id} caption={t('fe.exports.history')} />}
      </Card>
    </div>
  );
}
