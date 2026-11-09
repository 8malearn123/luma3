'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Minus, Play, Sparkles } from 'lucide-react';
import { LoomResultsSummary } from './LoomResults';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { loomKey, PlanStatus, useAct } from './loom-shared';
import { LoomPlanActionList } from './LoomPlanActions';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';
export const CHECK_TONE: Record<string, Tone> = {
  ok: 'ok', constrained: 'warn', blocked: 'danger', unknown: 'neutral', reorder_needed: 'danger', no_recipe: 'warn', not_applicable: 'neutral',
  thin: 'warn', negative: 'danger', costs_incomplete: 'warn',
};
const levelTone = (l: string): Tone => (l === 'ok' ? 'ok' : l === 'limited' ? 'warn' : 'danger');

/**
 * Loom home page (§11.3), no chat: situation + data quality, top ≤5
 * opportunities, the current plan and this week, «بانتظار قرارك»,
 * measured results (phase 5), material alerts, and the setup reminder.
 */
export function LoomHome({ onNavigate }: { onNavigate: (tab: 'opportunities' | 'plans' | 'setup' | 'results') => void }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const [showImprove, setShowImprove] = useState(false);
  const r = useApiQuery<any>(loomKey(access.slug, 'home'), access.api('/loom/home'), { refetchInterval: 20000 });
  const canManage = access.can('marketing.manage');
  if (r.isLoading) return <LoadingState rows={5} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const fmt = (tile: any) => {
    if (tile.value === null || tile.value === undefined) return '—';
    if (tile.unit === 'minor') return formatMoney(tile.value, access.currency, locale);
    if (tile.unit === 'ratio') return `${Math.round(tile.value * 1000) / 10}%`;
    return String(Math.round(tile.value * 10) / 10);
  };
  const plan = (kind: 'monthly' | 'weekly', mode?: 'rules') => act(`plan${kind}${mode ?? ''}`, '/loom/plans', { body: { kind, ...(mode ? { mode } : {}) }, ok: t('loomp.home.plan_queued') });
  const live = d.situation.analysis && ['queued', 'running'].includes(d.situation.analysis.status);
  return (
    <div className="flex flex-col gap-4">
      {!d.setup.complete ? (
        <Alert tone="info" title={t('loomp.home.setup_title')}>
          <p>{t('loomp.home.setup_body', { list: d.setup.missing.map((m: any) => m.label).join(locale === 'ar' ? '، ' : ', ') })}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => onNavigate('setup')}>{t('loom.go_setup')}</Button>
        </Alert>
      ) : null}

      <Card title={t('loomp.home.situation')} actions={canManage ? <Button size="sm" icon={<Play className="size-4" />} loading={busy === 'run' || !!live} onClick={() => act('run', '/loom/analyses', { body: {}, ok: t('loom.queued') })}>{live ? t('loom.running') : t('loom.run')}</Button> : undefined}>
        {d.situation.analysis ? (
          <p className="mb-3 text-xs text-ink-muted">{t('loom.last_analysis', { time: formatDateTime(d.situation.analysis.finished_at, { locale, tz: access.timezone }) })}{d.situation.analysis.mode === 'exploratory' ? ` · ${t('loom.exploratory')}` : ''}</p>
        ) : <p className="mb-3 text-sm text-ink-muted">{t('loom.no_analysis')}</p>}
        {d.situation.tiles.length ? (
          <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {d.situation.tiles.map((tile: any) => (
              <div key={tile.key} className="rounded-xl border border-line p-3">
                <dt className="text-xs text-ink-muted">{tile.label}</dt>
                <dd className="mt-1 flex items-center gap-1 text-lg font-semibold tabular-nums" dir="ltr">
                  {fmt(tile)}
                  {tile.trend === 'up' ? <ArrowUp className="size-4 text-ok" aria-label={t('loomp.home.trend_up')} /> : tile.trend === 'down' ? <ArrowDown className="size-4 text-danger" aria-label={t('loomp.home.trend_down')} /> : tile.trend === 'flat' ? <Minus className="size-4 text-ink-muted" aria-label={t('loomp.home.trend_flat')} /> : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {d.situation.quality ? (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-ink-muted">{t('loom.dq.title')}:</span>
              {Object.entries(d.situation.quality.domains as Record<string, any>).map(([k, v]) => <Badge key={k} tone={levelTone(v.level)}>{t(`loom.dq.domains.${k}`)}: {t(`loom.quality.${v.level}`)}</Badge>)}
              <Button size="sm" variant="ghost" aria-expanded={showImprove} onClick={() => setShowImprove(!showImprove)}>{showImprove ? t('loom.card.hide') : t('loom.dq.improve')}</Button>
            </div>
            {showImprove ? (
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {Object.entries(d.situation.quality.domains as Record<string, any>).flatMap(([k, v]) => (v.improve as string[]).map((x, i) => <li key={`${k}${i}`}><span className="font-medium">{t(`loom.dq.domains.${k}`)}:</span> {x}</li>))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {d.situation.analysis?.data_needed?.length ? <Alert tone="warn" className="mt-3" title={t('loom.data_needed')}><ul className="list-disc ps-5">{d.situation.analysis.data_needed.map((x: string) => <li key={x}>{x}</li>)}</ul></Alert> : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('loomp.home.top')} actions={<Button size="sm" variant="ghost" onClick={() => onNavigate('opportunities')}>{t('marketing.summary.view_all')}</Button>}>
          {d.top_opportunities.length ? (
            <ul className="flex flex-col gap-3">
              {d.top_opportunities.map((o: any) => (
                <li key={o.id} className="rounded-xl border border-line p-3">
                  <p className="font-medium" dir="auto">{o.title}</p>
                  <p className="mt-1 text-sm text-ink-muted" dir="auto">{o.why_now}</p>
                  <ChecksRow checks={o.checks} />
                </li>
              ))}
            </ul>
          ) : <EmptyState title={t('loom.empty')} />}
        </Card>

        <Card title={t('loomp.home.pending')}>
          {!d.pending.opportunities.length && !d.pending.plan_revisions.length ? <p className="text-sm text-ink-muted">{t('loomp.home.nothing_pending')}</p> : null}
          {d.pending.plan_revisions.length ? (
            <div className="mb-3">
              <p className="text-xs font-medium text-ink-muted">{t('loomp.home.revisions')}</p>
              <ul className="mt-1 flex flex-col gap-2 text-sm">
                {d.pending.plan_revisions.map((p: any) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-luma-50 p-2">
                    <span dir="auto"><span className="font-medium">{p.title}</span>{p.reason ? <span className="block text-xs text-ink-muted">{t('loomp.home.revision_reason', { reason: p.reason })}</span> : null}</span>
                    <Button size="sm" variant="outline" onClick={() => onNavigate('plans')}>{t('loomp.home.review_revision')}</Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {d.pending.opportunities.length ? (
            <>
              <p className="text-xs font-medium text-ink-muted">{t('loomp.home.to_decide')}</p>
              <ul className="mt-1 flex flex-col gap-1 text-sm">
                {d.pending.opportunities.map((o: any) => (
                  <li key={o.id} className="flex items-center justify-between gap-2"><span dir="auto">{o.title}</span><Badge>{t(`loom.status.${o.status}`)}</Badge></li>
                ))}
              </ul>
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => onNavigate('opportunities')}>{t('loomp.home.decide')}</Button>
            </>
          ) : null}
        </Card>
      </div>

      <Card title={t('loomp.home.plan')} actions={canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<Sparkles className="size-4" />} loading={busy === 'planmonthly'} onClick={() => plan('monthly')}>{t('loomp.home.make_monthly')}</Button>
          <Button size="sm" variant="secondary" loading={busy === 'planweekly'} onClick={() => plan('weekly')}>{t('loomp.home.make_weekly')}</Button>
        </div>
      ) : undefined}>
        {d.plan.last_run?.note ? <Alert tone="warn" className="mb-3">{d.plan.last_run.note}</Alert> : null}
        {d.plan.last_run && d.plan.last_run.status === 'insufficient_data' ? <Alert tone="warn" className="mb-3">{t('loomp.home.plan_insufficient')}</Alert> : null}
        <div className="flex flex-wrap gap-4 text-sm">
          {(['monthly', 'weekly'] as const).map((k) => d.plan[k] ? (
            <div key={k} className="flex items-center gap-2">
              <Badge>{t(`marketing.kinds.${k}`)}</Badge><span dir="auto">{d.plan[k].title}</span><PlanStatus status={d.plan[k].status} />
              {d.plan[k].has_unapproved_changes ? <Badge tone="info">{t('loomp.home.unapproved')}</Badge> : null}
            </div>
          ) : <p key={k} className="text-ink-muted">{t(`loomp.home.no_${k}`)}</p>)}
        </div>
        <h3 className="mt-4 text-sm font-semibold">{t('loomp.home.this_week')}</h3>
        {d.plan.this_week.length ? <LoomPlanActionList actions={d.plan.this_week} compact /> : <p className="text-sm text-ink-muted">{t('loomp.home.week_empty')}</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('loomp.home.alerts')}>
          {d.alerts.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {d.alerts.map((a: any) => (
                <li key={a.id} className="rounded-lg border border-line p-2">
                  <div className="flex flex-wrap items-center gap-2"><Badge tone={a.kind === 'material' ? 'danger' : 'warn'}>{t(`loomp.home.alert_${a.kind}`)}</Badge><span dir="auto">{a.title}</span></div>
                  {a.note ? <p className="mt-1 text-xs text-ink-muted" dir="auto">{a.note}</p> : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-muted">{t('loomp.home.no_alerts')}</p>}
        </Card>
      </div>
      <LoomResultsSummary onViewAll={() => onNavigate('results')} />
    </div>
  );
}

export function ChecksRow({ checks }: { checks: { capacity: string; inventory: string; margin: string } }) {
  const { t } = useI18n();
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
      <Badge tone={CHECK_TONE[checks.capacity]}>{t('loom.card.capacity')}: {t(`loom.capacity.${checks.capacity}`)}</Badge>
      <Badge tone={CHECK_TONE[checks.inventory]}>{t('loom.card.inventory')}: {t(`loom.inventory.${checks.inventory}`)}</Badge>
      <Badge tone={CHECK_TONE[checks.margin]}>{t('loom.card.margin')}: {t(`loom.margin.${checks.margin}`)}</Badge>
    </div>
  );
}
