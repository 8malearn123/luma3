'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { formatNumber } from '@/shared/format';
import { useApiQuery, useDebounced } from '../hooks';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Select } from '../components/form';
import { Card, DataTable, PageHeader, Stat } from '../components/layout';
import { SearchBox, Toolbar, When, qs } from './common';
import { IntegrationState } from './Overview';

type AiRow = { tenant_id: string; slug: string; name: string; month: string; runs: number; succeeded: number; failed: number; input_tokens: number | null; output_tokens: number | null; cost_usd_micros: number | null; runs_with_cost: number; cost_status: 'known' | 'partial' | 'unknown' };
type Ai = { items: AiRow[]; totals: { runs: number; succeeded: number; cost_usd_micros: number; cost_status: string }; pricing_configured: boolean };

function Usd({ micros, status }: { micros: number | null; status: string }) {
  const { t, locale } = useI18n();
  if (status === 'unknown' || micros == null) return <span className="text-ink-muted">{t('platform.ai.cost_unknown')}</span>;
  return <span dir="ltr">${formatNumber(micros / 1_000_000, locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}{status === 'partial' ? <Badge tone="warn" className="ms-1">{t('platform.ai.partial')}</Badge> : null}</span>;
}

export function AiUsagePage() {
  const { t, locale } = useI18n();
  const [months, setMonths] = useState('3');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const path = `/api/v1/platform/ai-usage${qs({ months, q: dq })}`;
  const r = useApiQuery<Ai>(['platform', 'ai', path], path);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('platform.ai.title')} subtitle={t('platform.ai.subtitle')} />
      {r.data && !r.data.pricing_configured ? <Alert tone="info">{t('platform.ai.no_pricing')}</Alert> : null}
      <Toolbar>
        <SearchBox value={q} onChange={setQ} label={t('platform.tenants.search')} />
        <Select aria-label={t('platform.revenue.range')} className="w-auto" value={months} onChange={(e) => setMonths(e.target.value)}>{['1', '3', '6', '12'].map((m) => <option key={m} value={m}>{t('platform.revenue.months', { n: m })}</option>)}</Select>
      </Toolbar>
      {r.isLoading ? <LoadingState /> : r.error ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Stat label={t('platform.ai.runs')} value={formatNumber(r.data!.totals.runs, locale)} />
            <Stat label={t('platform.ai.succeeded')} value={formatNumber(r.data!.totals.succeeded, locale)} />
            <Stat label={t('platform.ai.cost')} value={<Usd micros={r.data!.totals.cost_usd_micros} status={r.data!.totals.cost_status} />} />
          </div>
          {r.data!.items.length ? (
            <DataTable rows={r.data!.items} rowKey={(x) => `${x.tenant_id}-${x.month}`} caption={t('platform.ai.title')} columns={[
              { key: 'm', header: t('platform.revenue.month'), cell: (x) => <span dir="ltr">{x.month}</span> },
              { key: 't', header: t('platform.business'), cell: (x) => <div><p>{x.name}</p><p className="text-xs text-ink-muted" dir="ltr">/{x.slug}</p></div> },
              { key: 'r', header: t('platform.ai.runs'), cell: (x) => `${x.succeeded} / ${x.runs}` },
              { key: 'f', header: t('platform.ai.failed'), cell: (x) => x.failed ? <span className="text-danger">{x.failed}</span> : 0 },
              { key: 'tok', header: t('platform.ai.tokens'), className: 'hidden md:table-cell', cell: (x) => x.input_tokens == null ? '—' : <span dir="ltr">{formatNumber(x.input_tokens, locale)} / {formatNumber(x.output_tokens ?? 0, locale)}</span> },
              { key: 'c', header: t('platform.ai.cost'), cell: (x) => <Usd micros={x.cost_usd_micros} status={x.cost_status} /> },
            ]} />
          ) : <EmptyState title={t('platform.ai.empty')} />}
        </>
      )}
    </div>
  );
}

type Health = {
  messaging: Record<'email' | 'sms' | 'whatsapp', string>;
  ai: { status: { state: string; reason?: string; provider?: string; model?: string; verified_at?: string | null }; last_success_at: string | null; last_24h: Array<{ status: string; n: number }> };
  payments: { accounts: Array<{ provider: string; mode: string; status: string; n: number }>; live_accounts: number; sandbox_accounts: number };
  storage: { driver: string };
  jobs: { by_kind: Array<{ kind: string; failed_24h: number; failed_7d: number; queued: number; running: number }>; recent_failures: Array<{ id: string; kind: string; attempts: number; last_error: string | null; created_at: string }> };
  outbox: { pending: number; oldest: string | null; erroring: number };
  provider_events: { needs_review: number; failed: number; invalid_signature_7d: number };
  deliveries_7d: Array<{ channel: string; status: string; n: number }>;
};

export function IntegrationsPage() {
  const { t } = useI18n();
  const r = useApiQuery<Health>(['platform', 'integrations'], '/api/v1/platform/integrations', { refetchInterval: 60_000 });
  if (r.isLoading) return <LoadingState rows={5} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const h = r.data!;
  const aiState = h.ai.status.state === 'connected' && !h.ai.last_success_at ? 'configured_unverified' : h.ai.status.state;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('platform.integrations.title')} subtitle={t('platform.integrations.subtitle')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('platform.integrations.messaging')}>
          <ul className="flex flex-col gap-2 text-sm">
            {(['email', 'sms', 'whatsapp'] as const).map((c) => <li key={c} className="flex items-center justify-between"><span>{t(`platform.channels.${c}`)}</span><IntegrationState state={h.messaging[c]} /></li>)}
          </ul>
          <p className="mt-3 text-xs text-ink-muted">{t('platform.integrations.messaging_note')}</p>
        </Card>
        <Card title={t('platform.integrations.ai')}>
          <div className="flex items-center justify-between text-sm"><span>{h.ai.status.provider ?? '—'} {h.ai.status.model ? <span dir="ltr" className="text-xs text-ink-muted">({h.ai.status.model})</span> : null}</span><IntegrationState state={aiState} /></div>
          {h.ai.status.reason ? <p className="mt-1 text-xs text-ink-muted">{t(`platform.integrations.ai_reason.${h.ai.status.reason}`)}</p> : null}
          <p className="mt-2 text-xs">{t('platform.integrations.last_success')}: <When v={h.ai.last_success_at} /></p>
          <p className="mt-1 text-xs text-ink-muted">{h.ai.last_24h.map((x) => `${x.status}: ${x.n}`).join(' · ') || t('platform.integrations.no_runs_24h')}</p>
        </Card>
        <Card title={t('platform.integrations.payments')}>
          <div className="flex gap-4 text-sm"><span>{t('platform.integrations.sandbox_accounts')}: <strong>{h.payments.sandbox_accounts}</strong></span><span>{t('platform.integrations.live_accounts')}: <strong>{h.payments.live_accounts}</strong></span></div>
          <ul className="mt-2 text-xs text-ink-muted">{h.payments.accounts.map((a) => <li key={`${a.provider}${a.mode}${a.status}`} dir="ltr">{a.provider} · {a.mode} · {a.status}: {a.n}</li>)}</ul>
          <p className="mt-2 text-xs text-ink-muted">{t('platform.integrations.payments_note')}</p>
        </Card>
        <Card title={t('platform.integrations.storage')}>
          <p className="text-sm"><Badge>{h.storage.driver}</Badge></p>
          <p className="mt-2 text-xs text-ink-muted">{t('platform.integrations.storage_note')}</p>
        </Card>
        <Card title={t('platform.integrations.errors')}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt>{t('platform.integrations.outbox_pending')}</dt><dd>{h.outbox.pending} {h.outbox.oldest ? <span className="text-xs text-ink-muted">(<When v={h.outbox.oldest} />)</span> : null}</dd>
            <dt>{t('platform.integrations.outbox_erroring')}</dt><dd className={h.outbox.erroring ? 'text-danger' : ''}>{h.outbox.erroring}</dd>
            <dt>{t('platform.integrations.provider_review')}</dt><dd className={h.provider_events.needs_review ? 'text-warn' : ''}>{h.provider_events.needs_review}</dd>
            <dt>{t('platform.integrations.provider_failed')}</dt><dd>{h.provider_events.failed}</dd>
            <dt>{t('platform.integrations.invalid_signatures')}</dt><dd className={h.provider_events.invalid_signature_7d ? 'text-danger' : ''}>{h.provider_events.invalid_signature_7d}</dd>
          </dl>
        </Card>
        <Card title={t('platform.integrations.jobs')}>
          {h.jobs.by_kind.length ? (
            <table className="w-full text-sm"><caption className="sr-only">{t('platform.integrations.jobs')}</caption>
              <thead><tr className="text-xs text-ink-muted"><th scope="col" className="text-start">{t('platform.integrations.kind')}</th><th scope="col">{t('platform.integrations.failed_jobs_24h')}</th><th scope="col">7d</th><th scope="col">{t('platform.integrations.queued')}</th></tr></thead>
              <tbody>{h.jobs.by_kind.map((j) => <tr key={j.kind} className="border-t border-line"><td className="py-1 font-mono text-xs" dir="ltr">{j.kind}</td><td className={j.failed_24h ? 'text-center text-danger' : 'text-center'}>{j.failed_24h}</td><td className="text-center">{j.failed_7d}</td><td className="text-center">{j.queued}</td></tr>)}</tbody>
            </table>
          ) : <p className="text-sm text-ink-muted">{t('platform.integrations.no_job_issues')}</p>}
          {h.jobs.recent_failures.length ? (
            <details className="mt-3 text-xs"><summary className="cursor-pointer text-luma-700">{t('platform.integrations.recent_failures')}</summary>
              <ul className="mt-2 flex flex-col gap-1">{h.jobs.recent_failures.map((f) => <li key={f.id} dir="ltr"><span className="font-mono">{f.kind}</span> ×{f.attempts}: {f.last_error}</li>)}</ul>
            </details>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
