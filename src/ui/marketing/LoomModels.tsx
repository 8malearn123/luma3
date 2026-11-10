'use client';

import { useState } from 'react';
import { BrainCircuit, RotateCcw } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { ConfirmDialog } from '../components/overlay';
import { loomKey, useAct } from './loom-shared';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';
const STATUS_TONE: Record<string, Tone> = { candidate: 'info', shadow: 'warn', active: 'ok', retired: 'neutral' };
const ELIG_TONE: Record<string, 'ok' | 'warn' | 'info'> = { trained: 'ok', skipped: 'ok', ineligible: 'warn', disabled: 'warn', failed: 'warn', not_checked: 'info' };
const round1 = (x: number) => Math.round(x * 10) / 10;
const fmt = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '—' : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));

type Ev = { primary: { key: string; value: number }; guardrails: Array<{ key: string; value: number }>; algorithm?: string } | null;
type Version = {
  id: string; model_kind: string; algorithm: string; version: number; status: string; retired_reason: string | null;
  training: { from: string; to: string; split_at: string; test_to: string; n_train: number };
  metrics: { primary: string; candidate: Ev; baseline: Ev; active: Ev };
  gate: { passed: boolean; margin: number; metric: string; reasons: string[] };
  shadow: { until: string | null; result: { passed?: boolean; pending?: boolean } | null };
};

/**
 * «النماذج» tab (phase 6, experimental): eligibility and why, per kind what
 * serves forecasts (active model or baseline), shadow / candidate versions
 * with their metrics against the baseline and the active version, rollback,
 * the latest forecasts and the shared-training consent (owner only).
 */
export function LoomModels() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const [rollback, setRollback] = useState<string | null>(null);
  const r = useApiQuery<any>(loomKey(access.slug, 'models'), access.api('/loom/models'));
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const canManage = access.can('marketing.manage');
  const e = d.eligibility;
  return (
    <div className="flex flex-col gap-4">
      <Card title={<span className="inline-flex items-center gap-2"><BrainCircuit className="size-5 text-luma-500" aria-hidden />{t('loom_models.title')} <Badge tone="warn">{t('loom_models.experimental')}</Badge></span>}
        actions={canManage && d.enabled ? <Button size="sm" variant="outline" loading={busy === 'train'} onClick={() => act('train', '/loom/models/train', { ok: t('loom_models.actions.queued') })}>{t('loom_models.actions.train')}</Button> : null}>
        <p className="text-sm text-ink-muted">{t('loom_models.subtitle')}</p>
        {!d.enabled ? <Alert tone="info" className="mt-3">{t('loom_models.disabled')}</Alert> : null}
      </Card>

      <Card title={t('loom_models.eligibility.title')}>
        <Alert tone={ELIG_TONE[e.status] ?? 'info'}>{t(`loom_models.eligibility.${e.status}`)}</Alert>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {e.history_days !== null ? <li>{t('loom_models.eligibility.history', { days: e.history_days })}</li> : null}
          {e.completed_transactions !== null ? <li>{t('loom_models.eligibility.tx', { n: e.completed_transactions })}</li> : null}
          <li className="text-ink-muted">{t('loom_models.eligibility.thresholds', { days: d.thresholds.min_days, n: d.thresholds.min_completed_transactions })}</li>
          {e.reasons.map((x: string) => <li key={x} className="text-warn" dir="auto">{x}</li>)}
          {e.checked_at ? <li className="text-xs text-ink-muted">{t('loom_models.eligibility.checked_at', { time: formatDateTime(e.checked_at, { locale, tz: access.timezone }) })}</li> : null}
        </ul>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {d.kinds.map((k: any) => (
          <Card key={k.kind} title={t(`loom_models.kind.${k.kind}`)}
            actions={<Badge tone={k.serving === 'model' ? 'ok' : 'neutral'}>{k.active ? t('loom_models.serving.model', { v: k.active.version }) : t('loom_models.serving.baseline')}</Badge>}>
            <p className="text-xs text-ink-muted">{t(`loom_models.kind_hint.${k.kind}`)}</p>
            {k.last_training ? (
              <p className="mt-2 text-xs">{t('loom_models.last_training', { s: t(`loom_models.train_status.${k.last_training.status}`) })}{k.last_training.reason ? ` — ${t(`loom_models.reasons.${k.last_training.reason}`)}` : ''}</p>
            ) : null}
            <div className="mt-3 flex flex-col gap-3">
              {[k.active, k.shadow, ...k.candidates].filter(Boolean).map((v: Version) => <VersionBlock key={v.id} v={v} />)}
              {!k.active && !k.shadow && !k.candidates.length ? <p className="text-sm text-ink-muted">{t('loom_models.empty')}</p> : null}
            </div>
            {k.active && canManage ? (
              <Button className="mt-3" size="sm" variant="outline" icon={<RotateCcw className="size-4" />} onClick={() => setRollback(k.kind)}>{t('loom_models.actions.rollback')}</Button>
            ) : null}
            {k.recent.some((v: Version) => v.status === 'retired') ? (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-ink-muted">{t('loom_models.history')}</summary>
                <ul className="mt-1 flex flex-col gap-1">
                  {k.recent.filter((v: Version) => v.status === 'retired').map((v: Version) => (
                    <li key={v.id}>{t('loom_models.version', { v: v.version })} · {t(`loom_models.status.${v.status}`)}{v.retired_reason ? ` — ${t(`loom_models.retired_reason.${v.retired_reason}`)}` : ''}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Card>
        ))}
      </div>

      <Forecasts />
      <Consent consent={d.consent} />

      <ConfirmDialog open={!!rollback} onClose={() => setRollback(null)} danger loading={busy === 'rollback'} title={t('loom_models.actions.rollback')} body={t('loom_models.actions.rollback_confirm')}
        onConfirm={async () => { await act('rollback', '/loom/models/rollback', { body: { model_kind: rollback }, ok: t('loom_models.actions.rolled_back') }); setRollback(null); }} />
    </div>
  );
}

function VersionBlock({ v }: { v: Version }) {
  const { t } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const { locale } = useI18n();
  const c = v.metrics.candidate, b = v.metrics.baseline, a = v.metrics.active;
  const gain = c && b && b.primary.value > 0 ? Math.round((1 - c.primary.value / b.primary.value) * 100) : null;
  const canPromote = access.can('marketing.manage') && ((v.status === 'candidate' && v.gate.passed) || (v.status === 'shadow' && v.shadow.result?.passed));
  return (
    <div className="rounded-xl border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t('loom_models.version', { v: v.version })} <span className="text-xs text-ink-muted" dir="ltr">{v.algorithm}</span></span>
        <Badge tone={STATUS_TONE[v.status] ?? 'neutral'}>{t(`loom_models.status.${v.status}`)}</Badge>
      </div>
      <p className="mt-1 text-xs text-ink-muted" dir="auto">{t('loom_models.training', { from: v.training.from, to: v.training.to, t: v.training.split_at, end: v.training.test_to, n: v.training.n_train })}</p>
      <table className="mt-2 w-full text-xs">
        <thead><tr className="text-ink-muted"><th className="text-start font-normal">{t(`loom_models.metric.${v.metrics.primary}`)}</th><th className="text-end font-normal">{t('loom_models.vs.candidate')}</th><th className="text-end font-normal">{t('loom_models.vs.baseline')}</th>{a ? <th className="text-end font-normal">{t('loom_models.vs.active')}</th> : null}</tr></thead>
        <tbody dir="ltr">
          {[c?.primary, ...(c?.guardrails ?? [])].filter(Boolean).map((m) => (
            <tr key={m!.key}>
              <td className="text-start" dir="auto">{t(`loom_models.metric.${m!.key}`)}</td>
              <td className="text-end">{fmt(m!.value)}</td>
              <td className="text-end">{fmt(m!.key === c?.primary.key ? b?.primary.value : b?.guardrails.find((x) => x.key === m!.key)?.value)}</td>
              {a ? <td className="text-end">{fmt(m!.key === c?.primary.key ? a.primary.value : a.guardrails.find((x) => x.key === m!.key)?.value)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-ink-muted">{t('loom_models.lower_better')} {gain !== null && gain > 0 ? t('loom_models.improvement', { p: gain }) : null}</p>
      <p className="mt-1 text-xs">
        {t('loom_models.gate.title')}: <Badge tone={v.gate.passed ? 'ok' : 'danger'}>{v.gate.passed ? t('loom_models.gate.passed') : t('loom_models.gate.failed')}</Badge>{' '}
        <span className="text-ink-muted">{t('loom_models.gate.margin', { m: Math.round(v.gate.margin * 100), metric: t(`loom_models.metric.${v.gate.metric}`) })}</span>
      </p>
      {v.status === 'shadow' && v.shadow.until ? (
        <p className="mt-1 text-xs">{t('loom_models.shadow.until', { date: formatDateTime(v.shadow.until, { locale, tz: access.timezone }) })}
          {v.shadow.result ? ` — ${t(v.shadow.result.passed ? 'loom_models.shadow.passed' : v.shadow.result.pending ? 'loom_models.shadow.pending' : 'loom_models.shadow.failed')}` : ''}</p>
      ) : null}
      {canPromote ? <Button className="mt-2" size="sm" loading={busy === v.id} onClick={() => act(v.id, `/loom/models/versions/${v.id}/promote`, { ok: t('loom_models.actions.promoted') })}>{t('loom_models.actions.promote')}</Button> : null}
    </div>
  );
}

const KIND_METRIC: Record<string, string> = { demand_forecast: 'demand_units', return_probability: 'returning_customers', intervention_response: 'intervention_response' };

function Forecasts() {
  const { t } = useI18n();
  const access = useAccess();
  const r = useApiQuery<any[]>(loomKey(access.slug, 'models', 'forecasts'), access.api('/loom/models/forecasts'));
  if (r.isLoading) return <LoadingState rows={2} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  // Demand rows are daily: shown as totals per offering over the horizon (interval from the summed variances).
  const byOffering = new Map<string, any>();
  for (const f of r.data!.filter((x) => x.model_kind === 'demand_forecast')) {
    const k = f.subject.offering_id as string;
    const cur = byOffering.get(k) ?? { ...f, subject_key: `offering:${k}`, value: 0, v: 0, horizon_from: f.horizon_from, horizon_to: f.horizon_to };
    cur.value += f.value; cur.v += ((f.high - f.low) / 3.29) ** 2;
    if (f.horizon_from < cur.horizon_from) cur.horizon_from = f.horizon_from;
    if (f.horizon_to > cur.horizon_to) cur.horizon_to = f.horizon_to;
    byOffering.set(k, cur);
  }
  const demand = [...byOffering.values()].map((f) => { const h = 1.645 * Math.sqrt(f.v); return { ...f, value: round1(f.value), low: round1(Math.max(0, f.value - h)), high: round1(f.value + h) }; });
  const rows = [...demand, ...r.data!.filter((x) => x.model_kind !== 'demand_forecast')].slice(0, 30);
  return (
    <Card title={t('loom_models.forecasts.title')}>
      <p className="mb-2 text-xs text-ink-muted">{t('loom_models.forecasts.not_goal')}</p>
      {!rows.length ? <EmptyState title={t('loom_models.forecasts.empty')} /> : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {rows.map((f, i) => (
            <li key={i} className="flex flex-wrap items-center justify-between gap-2">
              <span dir="auto">{t(`loom_models.card.metric.${KIND_METRIC[f.model_kind]}`)} <span className="text-xs text-ink-muted" dir="ltr">{f.subject_key.split('|')[0]}</span></span>
              <span className="text-xs" dir="auto">{f.value} · {t('loom_models.forecasts.interval', { low: f.low, high: f.high })} · {t('loom_models.forecasts.horizon', { from: f.horizon_from, to: f.horizon_to })}</span>
              <Badge tone={f.source === 'model' ? 'ok' : 'neutral'}>{f.source === 'model' ? t('loom_models.forecasts.model', { v: f.version }) : t('loom_models.forecasts.baseline')}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Consent({ consent }: { consent: { shared_training_consent: boolean; decided: boolean; updated_at: string | null } }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const owner = access.can('business.manage') && access.can('marketing.manage');
  const save = (v: boolean) => act(v ? 'con' : 'coff', '/loom/models/consent', { method: 'PUT', body: { shared_training_consent: v }, ok: t('loom_models.consent.saved') });
  return (
    <Card title={t('loom_models.consent.title')} actions={<Badge tone={consent.shared_training_consent ? 'ok' : 'neutral'}>{consent.shared_training_consent ? t('loom_models.consent.current_on') : t('loom_models.consent.current_off')}</Badge>}>
      <p className="text-sm text-ink-muted">{t('loom_models.consent.explain')}</p>
      <p className="mt-2 text-xs">{consent.decided && consent.updated_at ? t('loom_models.consent.decided', { time: formatDateTime(consent.updated_at, { locale, tz: access.timezone }) }) : t('loom_models.consent.none')}</p>
      {owner ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant={consent.shared_training_consent ? 'outline' : 'ghost'} loading={busy === 'coff'} onClick={() => save(false)}>{t('loom_models.consent.off')}</Button>
          <Button size="sm" variant={consent.shared_training_consent ? 'ghost' : 'outline'} loading={busy === 'con'} onClick={() => save(true)}>{t('loom_models.consent.on')}</Button>
        </div>
      ) : <p className="mt-2 text-xs text-ink-muted">{t('loom_models.consent.owner_only')}</p>}
    </Card>
  );
}
