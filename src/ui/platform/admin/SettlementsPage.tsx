'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../../api';
import { useApiQuery, useErrorMessage } from '../../hooks';
import { Button } from '../../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Field, FormErrorSummary, Input, Select } from '../../components/form';
import { Card, DataTable, PageHeader, Stat } from '../../components/layout';
import { Dialog } from '../../components/overlay';
import { useToast } from '../../components/toast';
import { Money, PageNav, Toolbar, qs } from '../common';
import { useStepUp } from '../stepup';
import { CsvLink, lastDays, PeriodPicker, type PeriodValue } from './period';

type Statement = { id: string; period_start: string; period_end: string; currency: string; gross_minor: number; refunds_minor: number; fee_minor: number; net_minor: number; payments_count: number; fee_source: string; status: 'simulated' | 'settled'; settlement_reference: string | null; tenant_slug: string; tenant_name: string };
type List = { items: Statement[]; total: number; totals: { gross_minor: number; refunds_minor: number; fee_minor: number; net_minor: number } };

export function SettlementsPage() {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const [period, setPeriod] = useState<PeriodValue>(lastDays(30));
  const [status, setStatus] = useState('');
  const [tenant, setTenant] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [settling, setSettling] = useState<Statement | null>(null);
  const filters = { from: period.from, to: period.to, status, tenant: /^[a-z0-9-]{3,48}$/.test(tenant) ? tenant : undefined };
  const path = `/api/v1/platform/settlements${qs({ ...filters, page, limit: 25 })}`;
  const q = useApiQuery<List>(['platform', 'settlements', path], path);

  async function generate() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ created: number; updated: number; skipped_settled: number }>('/api/v1/platform/settlements', { body: { from: period.from, to: period.to, ...(filters.tenant ? { tenant: filters.tenant } : {}) } });
      toast({ tone: 'ok', text: t('admin.settlements.generated', { created: r.created, updated: r.updated, skipped: r.skipped_settled }) });
      await qc.invalidateQueries({ queryKey: ['platform', 'settlements'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('admin.settlements.title')} subtitle={t('admin.settlements.subtitle')}
        actions={<><CsvLink href={`/api/v1/platform/settlements${qs({ ...filters, format: 'csv' })}`} /><Button loading={busy} onClick={generate}>{t('admin.settlements.generate')}</Button></>} />
      <PeriodPicker value={period} onChange={(v) => { setPeriod(v); setPage(1); }} />
      <Toolbar>
        <Input aria-label={t('admin.tenant_slug')} placeholder={t('admin.tenant_slug')} dir="ltr" className="w-48" value={tenant} onChange={(e) => { setTenant(e.target.value.trim().toLowerCase()); setPage(1); }} />
        <Select aria-label={t('admin.settlements.status')} className="w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">{t('admin.settlements.status')}: {t('admin.all')}</option>
          <option value="simulated">{t('admin.settlements.simulated')}</option>
          <option value="settled">{t('admin.settlements.settled')}</option>
        </Select>
      </Toolbar>
      <FormErrorSummary message={err ? msg(err) : null} />
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t('admin.settlements.gross')} value={<Money minor={q.data!.totals.gross_minor} />} hint={t('admin.settlements.totals')} />
            <Stat label={t('admin.settlements.refunds')} value={<Money minor={q.data!.totals.refunds_minor} />} />
            <Stat label={t('admin.settlements.fee')} value={<Money minor={q.data!.totals.fee_minor} />} />
            <Stat label={t('admin.settlements.net')} value={<Money minor={q.data!.totals.net_minor} />} />
          </div>
          <Card>
            {!q.data!.items.length ? <EmptyState title={t('admin.none')} /> : (
              <>
                <DataTable rows={q.data!.items} rowKey={(s) => s.id} caption={t('admin.settlements.title')} columns={[
                  { key: 't', header: t('admin.tenant'), cell: (s) => s.tenant_name },
                  { key: 'p', header: t('admin.period.label'), className: 'hidden md:table-cell', cell: (s) => <span dir="ltr" className="text-xs">{s.period_start} → {s.period_end}</span> },
                  { key: 'g', header: t('admin.settlements.gross'), cell: (s) => <Money minor={s.gross_minor} currency={s.currency} /> },
                  { key: 'r', header: t('admin.settlements.refunds'), className: 'hidden lg:table-cell', cell: (s) => <Money minor={s.refunds_minor} currency={s.currency} /> },
                  { key: 'f', header: t('admin.settlements.fee'), cell: (s) => <span title={t('admin.settlements.fee_source', { source: s.fee_source })}><Money minor={s.fee_minor} currency={s.currency} /></span> },
                  { key: 'n', header: t('admin.settlements.net'), cell: (s) => <strong><Money minor={s.net_minor} currency={s.currency} /></strong> },
                  { key: 's', header: t('admin.settlements.status'), cell: (s) => <Badge tone={s.status === 'settled' ? 'ok' : 'warn'}>{t(`admin.settlements.${s.status}`)}</Badge> },
                  { key: 'a', header: '', cell: (s) => (
                    <div className="flex items-center gap-2">
                      <a href={`/api/v1/platform/settlements/${s.id}?format=html`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-sm text-luma-700 hover:underline" aria-label={t('admin.settlements.open_statement')}>
                        {t('admin.settlements.statement')}<ExternalLink className="size-3.5" aria-hidden /></a>
                      {s.status === 'simulated' ? <Button size="sm" variant="outline" onClick={() => setSettling(s)}>{t('admin.settlements.settle')}</Button> : null}
                    </div>
                  ) },
                ]} />
                <PageNav page={page} total={q.data!.total} limit={25} onPage={setPage} />
              </>
            )}
          </Card>
        </>
      )}
      {settling ? <SettleDialog s={settling} onClose={() => setSettling(null)} /> : null}
    </div>
  );
}

function SettleDialog({ s, onClose }: { s: Statement; onClose: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api(`/api/v1/platform/settlements/${s.id}/settle`, { body: { reference: ref } }));
      await qc.invalidateQueries({ queryKey: ['platform', 'settlements'] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={t('admin.settlements.settle_title')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} disabled={ref.trim().length < 2} onClick={save}>{t('admin.settlements.settle')}</Button></>}>
      <div className="flex flex-col gap-3">
        <p className="text-sm">{s.tenant_name} · <Money minor={s.net_minor} currency={s.currency} /></p>
        <p className="text-sm text-ink-muted">{t('admin.settlements.settle_body')}</p>
        <FormErrorSummary message={err ? msg(err) : null} />
        <Field label={t('admin.settlements.reference')} required>{(p) => <Input {...p} dir="ltr" value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}
