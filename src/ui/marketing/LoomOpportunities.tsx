'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Play, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDate, formatDateTime, formatMoney } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, Input, MoneyInput, Select, Textarea } from '../components/form';
import { Card } from '../components/layout';
import { loomKey, useAct } from './loom-shared';
import { DecisionHistory } from './LoomResults';

const REASONS = ['capacity_staffing', 'capacity_inventory', 'budget', 'brand_fit', 'timing', 'already_doing', 'disagree_with_data', 'not_valuable', 'other'] as const;
const NON_IDEA = ['capacity_staffing', 'capacity_inventory', 'budget', 'timing'];
type Filter = 'top' | 'study' | 'blocked' | 'all' | 'closed';
type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';
const CHECK_TONE: Record<string, Tone> = {
  ok: 'ok', constrained: 'warn', blocked: 'danger', unknown: 'neutral', reorder_needed: 'danger', no_recipe: 'warn', not_applicable: 'neutral',
  thin: 'warn', negative: 'danger', costs_incomplete: 'warn',
};

/** «الفرص»: ranked opportunity cards with every §11.1 field, decisions and conversions. */
export function LoomOpportunities({ onSetup }: { onSetup?: () => void }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const [filter, setFilter] = useState<Filter>('all');
  const analyses = useApiQuery<any[]>(loomKey(access.slug, 'analyses'), access.api('/loom/analyses'), { refetchInterval: 8000 });
  const setup = useApiQuery<any>(loomKey(access.slug, 'setup'), access.api('/loom/setup'));
  const dq = useApiQuery<any>(loomKey(access.slug, 'dq'), access.api('/loom/data-quality'));
  const query = filter === 'all' ? '' : filter === 'closed' ? '?open=0' : `?bucket=${filter}`;
  const list = useApiQuery<any[]>(loomKey(access.slug, 'opps', filter), access.api(`/loom/opportunities${query}`));
  const canManage = access.can('marketing.manage');
  const last = analyses.data?.[0];
  const live = last && ['queued', 'running'].includes(last.status);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-ink-muted">{t('loom.subtitle')}</p>
            <p className="mt-1 text-xs text-ink-muted">{last ? t('loom.last_analysis', { time: formatDateTime(last.finished_at ?? last.created_at, { locale, tz: access.timezone }) }) : t('loom.no_analysis')}</p>
          </div>
          {canManage ? <Button icon={<Play className="size-4" />} loading={busy === 'run' || !!live} onClick={() => act('run', '/loom/analyses', { body: {}, ok: t('loom.queued') })}>{live ? t('loom.running') : t('loom.run')}</Button> : null}
        </div>
        {last?.mode === 'exploratory' ? (
          <Alert tone="warn" className="mt-3" title={t('loom.exploratory')}>
            {last.result?.data_needed?.length ? <><p className="font-medium">{t('loom.data_needed')}</p><ul className="list-disc ps-5">{last.result.data_needed.map((d: string) => <li key={d}>{d}</li>)}</ul></> : null}
          </Alert>
        ) : null}
        {setup.data && !setup.data.complete ? (
          <Alert tone="info" className="mt-3">
            {t('loom.setup_missing', { list: setup.data.items.filter((i: any) => !i.confirmed).map((i: any) => i.label).join(locale === 'ar' ? '، ' : ', ') })}
            {onSetup ? <Button size="sm" variant="outline" className="ms-2" onClick={onSetup}>{t('loom.go_setup')}</Button> : null}
          </Alert>
        ) : null}
      </Card>
      {dq.data?.report ? <QualityStrip report={dq.data.report} /> : null}
      <Field label={t('loom.filter.label')} className="w-64">
        {(p) => <Select {...p} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>{(['all', 'top', 'study', 'blocked', 'closed'] as const).map((f) => <option key={f} value={f}>{t(`loom.filter.${f}`)}</option>)}</Select>}
      </Field>
      {list.isLoading ? <LoadingState rows={3} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data!.length ? <EmptyState title={t('loom.empty')} /> : (
        <ul className="flex flex-col gap-3">{list.data!.map((o) => <OpportunityCard key={o.card.opportunity_id} o={o} />)}</ul>
      )}
    </div>
  );
}

function QualityStrip({ report }: { report: any }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const tone = (l: string): Tone => (l === 'ok' ? 'ok' : l === 'limited' ? 'warn' : 'danger');
  return (
    <Card title={t('loom.dq.title')} actions={<Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('loom.card.hide') : t('loom.dq.improve')}</Button>}>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(report.domains as Record<string, any>).map(([k, v]) => <Badge key={k} tone={tone(v.level)}>{t(`loom.dq.domains.${k}`)}: {t(`loom.quality.${v.level}`)}</Badge>)}
      </div>
      {open ? (
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {Object.entries(report.domains as Record<string, any>).flatMap(([k, v]) => (v.improve as string[]).map((x, i) => <li key={`${k}${i}`}><span className="font-medium">{t(`loom.dq.domains.${k}`)}:</span> {x}</li>))}
        </ul>
      ) : null}
    </Card>
  );
}

function OpportunityCard({ o }: { o: any }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const c = o.card;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<null | 'defer' | 'dismiss'>(null);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  const detail = useApiQuery<any>(loomKey(access.slug, 'opp', c.opportunity_id), open ? access.api(`/loom/opportunities/${c.opportunity_id}`) : null);
  const canManage = access.can('marketing.manage');
  const money = (v: number | null) => (v == null ? '—' : formatMoney(v, access.currency, locale));
  const decide = (body: Record<string, unknown>) => act(`d${body.action}`, `/loom/opportunities/${c.opportunity_id}/decision`, { body, ok: t('loom.decision.done') }).then((r) => { if (r) { setMode(null); setReason(''); setNote(''); } });
  const convert = (body: Record<string, unknown>) => act(`c${body.target}`, `/loom/opportunities/${c.opportunity_id}/convert`, { body, ok: t('loom.convert.done') });
  const open_ = ['detected', 'assessed', 'proposed', 'studying'].includes(o.status);
  return (
    <li className="rounded-2xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold" dir="auto">{c.title}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge tone="brand">{t(`loom.category.${c.category}`)}</Badge>
            {o.bucket ? <Badge tone={o.bucket === 'top' ? 'ok' : o.bucket === 'blocked' ? 'warn' : 'neutral'}>{t(`loom.bucket.${o.bucket}`)}</Badge> : null}
            <Badge>{t(`loom.status.${o.status}`)}</Badge>
            <Badge tone={c.priority.evidence_strength === 'strong' ? 'ok' : c.priority.evidence_strength === 'moderate' ? 'info' : 'warn'}>{t(`loom.strength.${c.priority.evidence_strength}`)}</Badge>
            <Badge>{t('loom.card.priority', { rank: c.priority.rank })}</Badge>
            {o.resurfaced ? <Badge tone="ok">{t('loom_memory.resurfaced')} ({t(`loom_memory.resurfaced_reason.${o.resurfaced.reason}`)})</Badge> : null}
          </div>
        </div>
        <Button size="sm" variant="ghost" aria-expanded={open} icon={open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />} onClick={() => { if (!open) void act('viewed', `/loom/opportunities/${c.opportunity_id}/feedback`, { body: { kind: 'viewed' }, invalidate: [] }); setOpen(!open); }}>{open ? t('loom.card.hide') : t('loom.card.details')}</Button>
      </div>
      <p className="mt-2 text-sm" dir="auto"><span className="font-medium">{t('loom.card.why_now')}:</span> {c.why_now}</p>
      <p className="mt-1 text-sm" dir="auto"><span className="font-medium">{t('loom.card.action')} ({t(`loom.action_kind.${c.recommended_action.kind}`)}):</span> {c.recommended_action.description}</p>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <Badge tone={CHECK_TONE[c.capacity_check.status]}>{t('loom.card.capacity')}: {t(`loom.capacity.${c.capacity_check.status}`)}</Badge>
        <Badge tone={CHECK_TONE[c.inventory_check.status]}>{t('loom.card.inventory')}: {t(`loom.inventory.${c.inventory_check.status}`)}{c.inventory_check.covers_n != null ? ` · ${t('loom.card.covers', { n: c.inventory_check.covers_n })}` : ''}</Badge>
        <Badge tone={CHECK_TONE[c.margin_check.status]}>{t('loom.card.margin')}: {t(`loom.margin.${c.margin_check.status}`)}</Badge>
      </div>
      <p className="mt-2 text-xs text-ink-muted" dir="auto">{c.priority.explanation}</p>
      {open ? (
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <Detail label={t('loom.card.period')} value={`${c.period.from} → ${c.period.to}`} ltr />
          <Detail label={t('loom.card.timing')} value={`${c.timing.window}${c.timing.event_ref ? ` · ${t('loom.card.event')}` : ''}`} />
          <Detail label={t('loom.card.segment')} value={`${c.target_segment.size != null ? t('loom.card.segment_size', { n: c.target_segment.size }) : '—'} (${t(`loom.segment_status.${c.target_segment.size_status}`)})`} />
          <Detail label={t('loom.card.channel')} value={c.channel.join(', ') || '—'} />
          <Detail label={t('loom.card.cost')} value={`${money(c.estimated_cost.amount_minor)} (${t(`loom.cost_basis.${c.estimated_cost.basis}`)})`} />
          <Detail label={t('loom.card.capacity')} value={`${c.capacity_check.note}${c.capacity_check.max_additional != null ? ` · ${t('loom.card.max_additional', { n: c.capacity_check.max_additional })}` : ''}`} />
          <Detail label={t('loom.card.inventory')} value={o.details.inventory_note || t(`loom.inventory.${c.inventory_check.status}`)} />
          <Detail label={t('loom.card.margin')} value={[
            o.details.margin_note,
            c.margin_check.unit_margin_before_minor != null ? t('loom.card.margin_before', { amount: money(c.margin_check.unit_margin_before_minor) }) : '',
            c.margin_check.breakeven_volume_increase != null ? t('loom.card.breakeven', { pct: `${Math.round(c.margin_check.breakeven_volume_increase * 1000) / 10}%` }) : '',
          ].filter(Boolean).join(' · ')} />
          {c.prerequisites.length ? <ListDetail label={t('loom.card.prerequisites')} items={c.prerequisites} /> : null}
          {c.hypotheses.length ? <ListDetail label={t('loom.card.hypotheses')} items={c.hypotheses.map((h: any) => h.text)} /> : null}
          {c.alternatives_considered.length ? <ListDetail label={t('loom.card.alternatives')} items={c.alternatives_considered.map((a: any) => `${t(`loom.action_kind.${a.kind}`)}: ${a.rejected_because}`)} /> : null}
          <ListDetail label={`${t('loom.card.success')} (${t('loom.card.target_note')})`} items={c.success_metrics.map((m: any) => `${m.metric_key}: ${m.baseline ?? '—'} → ${m.target ?? '—'}`)} ltr />
          <Detail label={t('loom.card.measurement')} value={t(`loom.measurement.${c.measurement_design}`)} />
          <Detail label={t('loom.card.data_quality')} value={t(`loom.quality.${c.data_quality}`)} />
          {c.assumptions.length ? <ListDetail label={t('loom.card.assumptions')} items={c.assumptions} /> : null}
          {c.limitations.length ? <ListDetail label={t('loom.card.limitations')} items={c.limitations} /> : null}
          <div className="sm:col-span-2">
            <p className="text-xs font-medium text-ink-muted">{t('loom.card.evidence')}</p>
            {detail.isLoading ? <LoadingState rows={1} /> : (
              <ul className="mt-1 flex flex-col gap-1 text-xs">
                {(detail.data?.evidence ?? []).map((e: any) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2"><span className="font-mono" dir="ltr">{e.id}</span><span dir="auto">{e.label}</span>
                    <span dir="ltr">= {e.value ?? '—'} (n={e.n})</span><Badge>{t(`loom.card.evidence_grade.${e.grade}`)}</Badge></li>
                ))}
              </ul>
            )}
          </div>
          {c.draft_content ? <Detail label={t('loomp.card.draft')} value={c.draft_content.text} /> : null}
          <div className="sm:col-span-2">
            <p className="text-xs font-medium text-ink-muted">{t('loomp.card.methodology')}</p>
            {detail.data?.knowledge?.length ? (
              <ul className="mt-1 flex flex-col gap-1 text-xs">
                {detail.data.knowledge.map((k: any) => <li key={k.ref}><span dir="auto">{k.title}</span> <span className="text-ink-muted" dir="ltr">({k.ref} · {k.source?.reviewed_at})</span></li>)}
              </ul>
            ) : <p className="text-xs text-ink-muted">{t('loomp.card.no_methodology')}</p>}
            {o.details.wording ? <p className="mt-1 text-xs text-ink-muted">{t(`loomp.card.wording_${o.details.wording.source}`)}</p> : null}
          </div>
          <OpportunityNotes id={c.opportunity_id} notes={detail.data?.comments ?? []} canManage={canManage} />
          <div className="sm:col-span-2">
            <p className="text-xs font-medium text-ink-muted">{t('loom_memory.ladder.title')}</p>
            {detail.isLoading ? <LoadingState rows={1} /> : <DecisionHistory ladder={detail.data?.ladder ?? []} />}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            {(['like', 'dislike'] as const).map((r) => (
              <Button key={r} size="sm" variant={detail.data?.reaction === r ? 'secondary' : 'ghost'} aria-pressed={detail.data?.reaction === r} loading={busy === `r${r}`}
                icon={r === 'like' ? <ThumbsUp className="size-4" /> : <ThumbsDown className="size-4" />}
                onClick={() => act(`r${r}`, `/loom/opportunities/${c.opportunity_id}/feedback`, { body: { kind: 'reaction', reaction: detail.data?.reaction === r ? 'none' : r }, invalidate: [loomKey(access.slug, 'opp', c.opportunity_id)] })}>
                {t(`loom_memory.reaction.${r}`)}
              </Button>
            ))}
            <span className="text-xs text-ink-muted">{t('loom_memory.reaction.note')}</span>
          </div>
          <p className="text-xs text-ink-muted sm:col-span-2">{t('loom.card.review_at', { date: formatDate(c.review_at, { locale, tz: access.timezone }) })}</p>
        </div>
      ) : null}
      {canManage ? (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {open_ || o.status === 'deferred' ? <Button size="sm" loading={busy === 'dapprove'} onClick={() => decide({ action: 'approve' })}>{t('loom.decision.approve')}</Button> : null}
            {open_ && o.status !== 'studying' ? <Button size="sm" variant="secondary" loading={busy === 'dstudy'} onClick={() => decide({ action: 'study' })}>{t('loom.decision.study')}</Button> : null}
            {open_ ? <Button size="sm" variant="outline" onClick={() => setMode(mode === 'defer' ? null : 'defer')}>{t('loom.decision.defer')}</Button> : null}
            {open_ || ['deferred', 'accepted'].includes(o.status) ? <Button size="sm" variant="ghost" onClick={() => setMode(mode === 'dismiss' ? null : 'dismiss')}>{t('loom.decision.dismiss')}</Button> : null}
            {['deferred', 'dismissed'].includes(o.status) ? <Button size="sm" variant="ghost" loading={busy === 'dreopen'} onClick={() => decide({ action: 'reopen' })}>{t('loom.decision.reopen')}</Button> : null}
            {['proposed', 'studying', 'accepted', 'converted'].includes(o.status) ? (
              <>
                <Button size="sm" variant="outline" loading={busy === 'cplan_action'} onClick={() => convert({ target: 'plan_action' })}>{t('loom.convert.plan_action')}</Button>
                {access.hasFeature('feature.campaigns') && !['open_slots', 'staffing', 'restock', 'price_review'].includes(c.recommended_action.kind) ? (
                  <Button size="sm" variant="outline" loading={busy === 'ccampaign_draft'} onClick={() => convert({ target: 'campaign_draft' })}>{t('loom.convert.campaign_draft')}</Button>
                ) : null}
              </>
            ) : null}
          </div>
          {mode ? (
            <form className="flex flex-wrap items-end gap-2 rounded-lg bg-luma-50 p-3" onSubmit={(e) => { e.preventDefault(); if (!reason) return; void decide({ action: mode, reason, ...(mode === 'defer' ? { until } : {}), ...(note ? { note } : {}) }); }}>
              <Field label={t('loom.decision.reason')} className="w-60" required>{(p) => <Select {...p} required value={reason} onChange={(e) => setReason(e.target.value)}><option value="">{t('loom.decision.reason_required')}</option>{REASONS.map((r) => <option key={r} value={r}>{t(`loom.decision.reasons.${r}`)}</option>)}</Select>}</Field>
              {mode === 'defer' ? <Field label={t('loom.decision.until')} className="w-44" required>{(p) => <Input {...p} required type="date" dir="ltr" value={until} onChange={(e) => setUntil(e.target.value)} />}</Field> : null}
              <Field label={t('loom.decision.note')} className="min-w-56 flex-1" required={reason === 'other'}>{(p) => <Textarea {...p} rows={1} maxLength={1000} required={reason === 'other'} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              <Button type="submit" size="sm" loading={busy === `d${mode}`} disabled={!reason}>{t(`loom.decision.${mode}`)}</Button>
              {NON_IDEA.includes(reason) ? <p className="w-full text-xs text-ink-muted">{t('loom.decision.not_failure')}</p> : null}
            </form>
          ) : null}
          {c.recommended_action.kind === 'price_review' && access.can('catalog.edit') && ['proposed', 'studying', 'accepted', 'converted'].includes(o.status) ? (
            <form className="flex flex-wrap items-end gap-2 rounded-lg bg-luma-50 p-3" onSubmit={(e) => { e.preventDefault(); if (price !== null) void convert({ target: 'price_proposal', proposed_price_minor: price }); }}>
              <p className="w-full text-xs text-ink-muted">{t('loom.convert.price_hint')}</p>
              <Field label={t('loom.convert.new_price')} className="w-44">{(p) => <MoneyInput {...p} value={price} onChange={setPrice} />}</Field>
              <Button type="submit" size="sm" variant="outline" disabled={price === null} loading={busy === 'cprice_proposal'}>{t('loom.convert.price_proposal')}</Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function OpportunityNotes({ id, notes, canManage }: { id: string; notes: any[]; canManage: boolean }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const [body, setBody] = useState('');
  return (
    <div className="sm:col-span-2">
      <p className="text-xs font-medium text-ink-muted">{t('loomp.card.notes')}</p>
      {notes.length ? (
        <ul className="mt-1 flex flex-col gap-1 text-sm">
          {notes.map((n) => <li key={n.id}><span className="text-xs text-ink-muted">{formatDateTime(n.created_at, { locale, tz: access.timezone })}</span> <span dir="auto">{n.body}</span></li>)}
        </ul>
      ) : <p className="text-xs text-ink-muted">{t('loomp.card.no_notes')}</p>}
      {canManage ? (
        <form className="mt-2 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (body.trim() && await act('note', `/loom/opportunities/${id}/comments`, { body: { body: body.trim() } })) setBody(''); }}>
          <label className="sr-only" htmlFor={`note-${id}`}>{t('loomp.card.add_note')}</label>
          <Input id={`note-${id}`} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />
          <Button type="submit" size="sm" variant="outline" loading={busy === 'note'}>{t('loomp.card.add_note')}</Button>
        </form>
      ) : null}
    </div>
  );
}

function Detail({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return <div><p className="text-xs font-medium text-ink-muted">{label}</p><p dir={ltr ? 'ltr' : 'auto'}>{value}</p></div>;
}
function ListDetail({ label, items, ltr }: { label: string; items: string[]; ltr?: boolean }) {
  return <div><p className="text-xs font-medium text-ink-muted">{label}</p><ul className="list-disc ps-5" dir={ltr ? 'ltr' : 'auto'}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>;
}
