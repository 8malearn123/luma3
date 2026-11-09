'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, LineChart } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatMoney } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, Input, MoneyInput, Select, Textarea } from '../components/form';
import { Card } from '../components/layout';
import { loomKey, useAct } from './loom-shared';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';
const QUALITY_TONE: Record<string, Tone> = { experimental: 'ok', quasi: 'info', observational: 'warn', insufficient: 'neutral' };
const STATUS_TONE: Record<string, Tone> = { scheduled: 'neutral', executing: 'brand', completed: 'info', measured: 'ok', closed: 'neutral', cancelled: 'neutral' };
const CHANNELS = ['in_app', 'whatsapp', 'sms', 'email', 'instagram', 'storefront', 'in_store'] as const;

export function QualityBadge({ quality }: { quality: string | null }) {
  const { t } = useI18n();
  return <Badge tone={quality ? QUALITY_TONE[quality] ?? 'neutral' : 'neutral'}>{t(`loom_memory.quality.${quality ?? 'pending'}`)}</Badge>;
}

/**
 * «النتائج» tab (§11.3, phase 5): initiatives with status, what was executed,
 * measured results with measurement quality and limitations, and learnings.
 */
export function LoomResults() {
  const { t } = useI18n();
  const access = useAccess();
  const list = useApiQuery<any[]>(loomKey(access.slug, 'initiatives'), access.api('/loom/initiatives'));
  return (
    <div className="flex flex-col gap-4">
      <Card><p className="text-sm text-ink-muted">{t('loom_memory.subtitle')}</p></Card>
      <LoomResultsSummary />
      {list.isLoading ? <LoadingState rows={3} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data!.length ? <EmptyState title={t('loom_memory.empty')} /> : (
        <ul className="flex flex-col gap-3">{list.data!.map((i) => <InitiativeCard key={i.id} i={i} />)}</ul>
      )}
    </div>
  );
}

/**
 * Embeddable home block (GET /loom/results): latest measured results with
 * their quality, counts per status, and material change alerts. The planner's
 * home page embeds it as <LoomResultsSummary onViewAll={…} />.
 */
export function LoomResultsSummary({ onViewAll }: { onViewAll?: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const r = useApiQuery<any>(loomKey(access.slug, 'results'), access.api('/loom/results'));
  if (r.isLoading) return <LoadingState rows={2} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={<span className="inline-flex items-center gap-2"><LineChart className="size-5 text-luma-500" aria-hidden />{t('loom_memory.home.title')}</span>}
        actions={onViewAll ? <Button size="sm" variant="ghost" onClick={onViewAll}>{t('loom_memory.home.view_all')}</Button> : null}>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {Object.entries(d.counts as Record<string, number>).map(([k, n]) => <Badge key={k} tone={STATUS_TONE[k] ?? 'neutral'}>{t(`loom_memory.counts.${k}`)}: {n}</Badge>)}
        </div>
        {d.latest.length ? (
          <ul className="flex flex-col gap-2 text-sm">
            {d.latest.map((i: any) => (
              <li key={i.id} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center justify-between gap-2"><span dir="auto">{i.title}</span><QualityBadge quality={i.measurement.quality} /></span>
                {i.learnings[0] ? <span className="text-xs text-ink-muted" dir="auto">{i.learnings[0]}</span> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-muted">{t('loom_memory.home.none')}</p>}
      </Card>
      <Card title={t('loom_memory.home.alerts')}>
        {d.alerts.length ? (
          <ul className="flex flex-col gap-2 text-sm">
            {d.alerts.map((a: any) => (
              <li key={a.id} className="flex flex-col gap-0.5">
                <span dir="auto">{t('loom_memory.home.alert_line', { label: a.label, n: a.rechecked })}</span>
                {a.revisions.map((v: any) => <span key={v.version_id} className="text-xs text-ink-muted">{t('loom_memory.home.revision', { v: v.version })}</span>)}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-muted">{t('loom_memory.home.no_alerts')}</p>}
      </Card>
    </div>
  );
}

function InitiativeCard({ i }: { i: any }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const [open, setOpen] = useState(false);
  const money = (v: number | null | undefined) => (v == null ? '—' : formatMoney(v, access.currency, locale));
  const ex = i.execution;
  const res = i.results;
  const canManage = access.can('marketing.manage');
  const fmt = (m: any, v: number | null) => (v == null ? '—' : m.unit === 'minor' ? money(v) : m.unit === 'ratio' ? `${Math.round(v * 1000) / 10}%` : String(v));
  return (
    <li className="rounded-2xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold" dir="auto">{i.title}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge tone="brand">{t(`loom_memory.artifact.${i.artifact.kind}`)}</Badge>
            <Badge tone={STATUS_TONE[i.status]}>{t(`loom_memory.status.${i.status}`)}</Badge>
            <Badge>{t(`loom_memory.design.${i.measurement.design}`)}</Badge>
            <QualityBadge quality={i.measurement.quality} />
            {i.edited ? <Badge tone="info">{t('loom_memory.edited')}</Badge> : null}
          </div>
        </div>
        <Button size="sm" variant="ghost" aria-expanded={open} icon={open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />} onClick={() => setOpen(!open)}>{open ? t('loom_memory.hide') : t('loom_memory.details')}</Button>
      </div>
      <p className="mt-2 text-xs text-ink-muted" dir="ltr">{t('loom_memory.window', { from: i.window.from, to: i.window.to })}</p>
      <p className="mt-1 text-sm" dir="auto">{i.action.description}</p>
      <div className="mt-2 text-sm">
        <p className="text-xs font-medium text-ink-muted">{t('loom_memory.executed')}</p>
        {ex ? (
          <p>{t('loom_memory.execution_line', { from: ex.from, to: ex.to, source: t(`loom_memory.source.${ex.source}`) })}
            {ex.audience_size != null ? ` · ${t('loom_memory.audience', { n: ex.audience_size })}` : ''}{ex.actual_cost_minor != null ? ` · ${t('loom_memory.cost', { amount: money(ex.actual_cost_minor) })}` : ''}</p>
        ) : <p className="text-ink-muted">{t('loom_memory.not_executed')}</p>}
      </div>
      {i.measurement.quality ? <p className="mt-2 text-xs text-ink-muted">{t(`loom_memory.quality_hint.${i.measurement.quality}`)}</p> : null}
      {i.learnings.length ? <ListBlock label={t('loom_memory.learnings')} items={i.learnings} /> : null}
      {open && res ? (
        <div className="mt-3 flex flex-col gap-3 text-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <thead><tr className="text-ink-muted"><th className="p-1 text-start">{t('loom_memory.metric')}</th><th className="p-1">{t('loom_memory.before')}</th><th className="p-1">{t('loom_memory.during')}</th><th className="p-1">{t('loom_memory.control')}</th><th className="p-1">{t('loom_memory.estimate')}</th></tr></thead>
              <tbody>
                {res.primary.map((m: any) => (
                  <tr key={m.key} className="border-t border-line">
                    <td className="p-1">{m.label}</td><td className="p-1 text-center" dir="ltr">{fmt(m, m.target.pre)}</td><td className="p-1 text-center" dir="ltr">{fmt(m, m.target.post)}</td>
                    <td className="p-1 text-center" dir="ltr">{m.control ? `${fmt(m, m.control.pre)} → ${fmt(m, m.control.post)}` : '—'}</td><td className="p-1 text-center" dir="ltr">{fmt(m, m.estimate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {res.attributed ? <p>{t('loom_memory.attributed', { converters: res.attributed.converters, members: res.attributed.members, amount: money(res.attributed.net_minor) })}</p> : null}
          {res.incremental ? (
            <p>{res.incremental.status === 'estimated'
              ? t('loom_memory.incremental', { lift: (Math.round(res.incremental.conversion_rate_lift * 1000) / 10).toString(), amount: money(res.incremental.net_minor) })
              : t('loom_memory.incremental_insufficient', { min: res.incremental.min_group, t: res.incremental.members.target, h: res.incremental.members.holdout })}</p>
          ) : null}
          <div>
            <p className="text-xs font-medium text-ink-muted">{t('loom_memory.guardrails')}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">{res.guardrails.map((g: any) => <Badge key={g.key} tone={g.breached ? 'danger' : 'ok'}>{g.label}: {g.breached ? t('loom_memory.breached') : t('loom_memory.ok')}</Badge>)}</div>
          </div>
          {res.limitations.length ? <ListBlock label={t('loom_memory.limitations')} items={res.limitations} /> : null}
          {i.external_factors.length ? <ListBlock label={t('loom_memory.factors')} items={i.external_factors.map((f: any) => `${f.label}${f.at ? ` (${f.at})` : ''}`)} /> : null}
        </div>
      ) : null}
      {canManage && ['scheduled', 'executing'].includes(i.status) ? <ExecutionForm id={i.id} /> : null}
    </li>
  );
}

function ExecutionForm({ id }: { id: string }) {
  const { t } = useI18n();
  const { act, busy } = useAct();
  const [show, setShow] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [channel, setChannel] = useState('');
  const [audience, setAudience] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const [note, setNote] = useState('');
  if (!show) return <Button size="sm" variant="outline" className="mt-3" onClick={() => setShow(true)}>{t('loom_memory.record_execution')}</Button>;
  return (
    <form className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-luma-50 p-3" onSubmit={(e) => {
      e.preventDefault();
      void act(`ex${id}`, `/loom/initiatives/${id}/executions`, {
        body: { executed_from: from, executed_to: to, channel: channel || null, audience_size: audience ? Number(audience) : null, actual_cost_minor: cost, note: note || null }, ok: t('loom_memory.saved'),
      }).then((r) => { if (r) setShow(false); });
    }}>
      <Field label={t('loom_memory.executed_from')} className="w-40" required>{(p) => <Input {...p} required type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
      <Field label={t('loom_memory.executed_to')} className="w-40" required>{(p) => <Input {...p} required type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      <Field label={t('loom_memory.channel')} className="w-40">{(p) => <Select {...p} value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">—</option>{CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
      <Field label={t('loom_memory.audience_size')} className="w-32">{(p) => <Input {...p} type="number" min={0} dir="ltr" value={audience} onChange={(e) => setAudience(e.target.value)} />}</Field>
      <Field label={t('loom_memory.actual_cost')} className="w-40">{(p) => <MoneyInput {...p} value={cost} onChange={setCost} />}</Field>
      <Field label={t('loom_memory.note')} className="min-w-56 flex-1">{(p) => <Textarea {...p} rows={1} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      <Button type="submit" size="sm" loading={busy === `ex${id}`} disabled={!from || !to}>{t('loom_memory.save')}</Button>
    </form>
  );
}

function ListBlock({ label, items }: { label: string; items: string[] }) {
  return <div className="mt-2"><p className="text-xs font-medium text-ink-muted">{label}</p><ul className="list-disc ps-5 text-sm" dir="auto">{items.map((x, k) => <li key={k}>{x}</li>)}</ul></div>;
}

/** Decision ladder of one opportunity (shown inside the opportunity card). */
export function DecisionHistory({ ladder }: { ladder: any[] }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  if (!ladder.length) return <p className="text-xs text-ink-muted">{t('loom_memory.ladder.empty')}</p>;
  return (
    <ol className="flex flex-col gap-1 text-xs">
      {ladder.map((e, k) => (
        <li key={k} className="flex flex-wrap items-center gap-2">
          <span className="text-ink-muted" dir="ltr">{new Date(e.at).toLocaleString(locale === 'ar' ? 'ar-SA' : 'en-GB', { timeZone: access.timezone, dateStyle: 'short', timeStyle: 'short' })}</span>
          <Badge>{t(`loom_memory.ladder.stage.${e.stage}`)}</Badge>
          {e.action ? <span>{t(`loom_memory.ladder.action.${e.action}`)}</span> : null}
          {e.reason ? <span>· {t(`loom.decision.reasons.${e.reason}`)}</span> : null}
          {e.counts_as_idea_failure === false ? <Badge tone="info">{t('loom_memory.ladder.not_failure')}</Badge> : e.counts_as_idea_failure ? <Badge tone="warn">{t('loom_memory.ladder.failure')}</Badge> : null}
          {e.note ? <span className="text-ink-muted" dir="auto">— {e.note}</span> : null}
        </li>
      ))}
    </ol>
  );
}
