'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Alert, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, DataTable } from '../components/layout';
import { JobStatus, loomKey } from './loom-shared';

type Row = {
  id: string; kind: string; status: string; how: string | null; created_at: string; started_at: string | null; finished_at: string | null;
  reason: string | null;
};

const STALE_MIN = 5;

/**
 * «حالة التحليل» (LUMA-AUDIT-022): the actual state of Loom's background work —
 * business analyses (loom.analyses), plan preparations and revisions
 * (loom.planner_runs) and any earlier marketing jobs (ai_jobs) — with
 * timestamps and the reason of a failure. Earlier this tab read ai_jobs only
 * and said «لا توجد تحليلات» while Loom analyses had succeeded.
 */
export function LoomAnalysisStatus() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const analyses = useApiQuery<any[]>(loomKey(access.slug, 'analyses'), access.api('/loom/analyses'), { refetchInterval: 8000 });
  const runs = useApiQuery<any[]>(loomKey(access.slug, 'planner-runs'), access.api('/loom/plans'), { refetchInterval: 8000 });
  const legacy = useApiQuery<any[]>(loomKey(access.slug, 'jobs'), access.api('/marketing/jobs'), { refetchInterval: 15000 });
  const [openedAt] = useState(() => Date.now());
  if (analyses.isLoading || runs.isLoading) return <LoadingState rows={4} />;
  if (analyses.error) return <ErrorState error={analyses.error} onRetry={() => analyses.refetch()} />;
  if (runs.error) return <ErrorState error={runs.error} onRetry={() => runs.refetch()} />;

  const reason = (code: string | null | undefined, note?: string | null) => {
    if (note) return note;
    if (!code) return null;
    const k = `loomux.status.reasons.${code}`;
    const v = t(k);
    return v === k ? t('loomux.status.unknown_reason') : v;
  };
  const rows: Row[] = [
    ...(analyses.data ?? []).map((a): Row => ({ id: `a${a.id}`, kind: 'analysis', status: a.status, how: a.mode, created_at: a.created_at, started_at: a.started_at, finished_at: a.finished_at, reason: reason(a.error_code) })),
    ...(runs.data ?? []).map((r): Row => ({
      id: `p${r.id}`, kind: r.kind === 'revision' ? 'plan_revision' : `plan_${r.kind}`, status: r.status, how: r.source, created_at: r.created_at, started_at: null, finished_at: r.finished_at,
      reason: r.status === 'succeeded' ? r.note : reason(r.error_code),
    })),
    ...(legacy.data ?? []).map((j): Row => ({ id: `j${j.id}`, kind: 'legacy', status: j.status, how: null, created_at: j.created_at, started_at: j.started_at ?? null, finished_at: j.finished_at ?? null, reason: j.error_code ? t(`marketing.job_errors.${j.error_code}`) : null })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const whenText = (v: string | null) => (v ? formatDateTime(v, { locale, tz: access.timezone }) : '—');
  const when = (v: string | null) => <span className="whitespace-nowrap">{whenText(v)}</span>;
  const last = analyses.data?.[0];
  const stale = rows.some((r) => r.status === 'queued' && openedAt - new Date(r.created_at).getTime() > STALE_MIN * 60_000);
  const howLabel = (h: string | null) => (h ? (t(`loomux.status.how_v.${h}`) === `loomux.status.how_v.${h}` ? h : t(`loomux.status.how_v.${h}`)) : '—');

  return (
    <div className="flex flex-col gap-3">
      <Alert tone="info">{t('loomux.status.explanation')}</Alert>
      {stale ? <Alert tone="warn">{t('loomux.status.stale', { n: STALE_MIN })}</Alert> : null}
      <Card title={t('loomux.status.title')}>
        <p className="text-sm" data-testid="loom-latest-analysis">
          {last ? t('loomux.status.latest', { status: t(`marketing.job_status.${last.status}`), time: whenText(last.finished_at ?? last.started_at ?? last.created_at) }) : t('loomux.status.none')}
        </p>
      </Card>
      {!rows.length ? <EmptyState title={t('loomux.status.none')} /> : (
        <DataTable rows={rows} rowKey={(r) => r.id} caption={t('loomux.status.title')} columns={[
          { key: 'k', header: t('loomux.status.kind'), cell: (r) => t(`loomux.status.kinds.${r.kind}`) },
          { key: 's', header: t('loomux.status.state'), cell: (r) => <JobStatus status={r.status} /> },
          { key: 'h', header: t('loomux.status.how'), cell: (r) => howLabel(r.how) },
          { key: 'c', header: t('loomux.status.created'), cell: (r) => when(r.created_at) },
          { key: 'st', header: t('loomux.status.started'), cell: (r) => when(r.started_at) },
          { key: 'f', header: t('loomux.status.finished'), cell: (r) => when(r.finished_at) },
          { key: 'r', header: t('loomux.status.reason'), cell: (r) => r.reason ?? '—' },
        ]} />
      )}
    </div>
  );
}
