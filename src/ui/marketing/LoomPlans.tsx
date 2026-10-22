'use client';

import { useState } from 'react';
import { Download, GitCompare, MessageSquare, Pencil, RefreshCw } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney } from '@/shared/format';
import { useApiQuery, useUnsavedChangesWarning } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, Input, Select, Textarea } from '../components/form';
import { Card, Tabs } from '../components/layout';
import { Drawer } from '../components/overlay';
import { loomKey, PlanStatus, SourceBadge, useAct } from './loom-shared';

const ACTIONS_BY_STATUS: Record<string, string[]> = {
  draft: ['propose', 'review', 'approve', 'defer', 'reject'],
  proposed: ['review', 'approve', 'defer', 'reject'],
  under_review: ['approve', 'defer', 'reject'],
  approved: ['start', 'complete', 'defer'],
  in_progress: ['complete'],
  deferred: ['propose', 'reopen'],
  rejected: ['reopen'],
  completed: [],
};

export function LoomPlans() {
  const { t } = useI18n();
  const access = useAccess();
  const [kind, setKind] = useState<'all' | 'monthly' | 'weekly'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const r = useApiQuery<any[]>(loomKey(access.slug, 'plans', kind), access.api(`/marketing/plans${kind === 'all' ? '' : `?kind=${kind}`}`));
  return (
    <div className="flex flex-col gap-3">
      <Tabs value={kind} onChange={setKind} items={[{ value: 'all', label: t('marketing.plan.all') }, { value: 'monthly', label: t('marketing.kinds.monthly') }, { value: 'weekly', label: t('marketing.kinds.weekly') }]} />
      {r.isLoading ? <LoadingState rows={3} /> : r.error ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : !r.data!.length ? <EmptyState title={t('marketing.plan.empty')} /> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {r.data!.map((p: any) => (
            <li key={p.id}>
              <button className="w-full rounded-2xl border border-line bg-white p-4 text-start hover:border-luma-300" onClick={() => setOpen(p.id)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold" dir="auto">{p.title}</span>
                  {p.is_example ? <Badge tone="warn">{t('marketing.plan.example_badge')}</Badge> : <PlanStatus status={p.status} />}
                </div>
                <p className="mt-1 text-xs text-ink-muted" dir="ltr">{p.period_start} → {p.period_end}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <Badge>{t(`marketing.kinds.${p.kind}`)}</Badge>
                  {p.current_source ? <SourceBadge source={p.current_source} /> : null}
                  <span className="text-ink-muted">{t('marketing.plan.version_n', { n: p.current_version })}{p.approved_version ? ` • ${t('marketing.plan.approved_version')}: ${p.approved_version}` : ''}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open ? <PlanDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function PlanDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const r = useApiQuery<any>(loomKey(access.slug, 'plan', id), access.api(`/marketing/plans/${id}`));
  const [vIdx, setVIdx] = useState(0);
  const [mode, setMode] = useState<'view' | 'edit' | 'diff'>('view');
  const [comment, setComment] = useState('');
  const canManage = access.can('marketing.manage');
  const p = r.data;
  const v = p?.versions[vIdx];
  return (
    <Drawer open onClose={onClose} wide title={p?.title ?? t('states.loading')} footer={p && canManage && !p.is_example ? (
      <div className="flex w-full flex-wrap justify-end gap-2">
        {(ACTIONS_BY_STATUS[p.status] ?? []).map((a) => (
          <Button key={a} size="sm" variant={a === 'approve' ? 'primary' : a === 'reject' ? 'danger' : 'outline'} loading={busy === a}
            onClick={() => act(a, `/marketing/plans/${id}/transition`, { body: { action: a } })}>{t(`marketing.actions.${a}`)}</Button>
        ))}
        {p.has_unapproved_changes ? <Button size="sm" loading={busy === 'approve'} onClick={() => act('approve', `/marketing/plans/${id}/transition`, { body: { action: 'approve' } })}>{t('marketing.actions.approve')} ({t('marketing.plan.version_n', { n: p.versions[0].version })})</Button> : null}
      </div>
    ) : undefined}>
      {r.isLoading ? <LoadingState rows={5} /> : r.error ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {p.is_example ? <Badge tone="warn">{t('marketing.plan.example_badge')}</Badge> : <PlanStatus status={p.status} />}
            <Badge>{t(`marketing.kinds.${p.kind}`)}</Badge>
            <span className="text-xs text-ink-muted" dir="ltr">{p.period_start} → {p.period_end}</span>
            {p.parent ? <span className="text-xs text-ink-muted">{t('marketing.plan.parent')}: {p.parent.title}</span> : null}
          </div>
          {p.is_example ? <Alert tone="warn">{t('marketing.source.example')}</Alert> : null}
          {p.has_unapproved_changes ? <Alert tone="info">{t('marketing.plan.newer_unapproved')}</Alert> : null}
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('marketing.plan.versions')} className="w-56">
              {(fp) => <Select {...fp} value={vIdx} onChange={(e) => setVIdx(Number(e.target.value))}>{p.versions.map((x: any, i: number) => <option key={x.id} value={i}>{t('marketing.plan.version_n', { n: x.version })} — {t(`marketing.source.${x.source}`)}{x.id === p.approved_version_id ? ` ✓` : ''}</option>)}</Select>}
            </Field>
            <Button size="sm" variant={mode === 'diff' ? 'secondary' : 'ghost'} icon={<GitCompare className="size-4" />} disabled={p.versions.length < 2} onClick={() => setMode(mode === 'diff' ? 'view' : 'diff')}>{t('marketing.actions.compare')}</Button>
            {canManage && !p.is_example && !['completed', 'rejected'].includes(p.status) ? <Button size="sm" variant={mode === 'edit' ? 'secondary' : 'ghost'} icon={<Pencil className="size-4" />} onClick={() => { setVIdx(0); setMode(mode === 'edit' ? 'view' : 'edit'); }}>{t('marketing.actions.edit')}</Button> : null}
            <a className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm text-luma-800 hover:bg-luma-100" href={access.api(`/marketing/plans/${id}/export?format=json&version=${v.version}`)} download><Download className="size-4" aria-hidden />{t('marketing.actions.export_json')}</a>
            <a className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm text-luma-800 hover:bg-luma-100" href={access.api(`/marketing/plans/${id}/export?format=csv&version=${v.version}`)} download><Download className="size-4" aria-hidden />{t('marketing.actions.export_csv')}</a>
            {canManage && !p.is_example ? <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} loading={busy === 'regen'} onClick={() => act('regen', `/marketing/plans/${id}/regenerate`, { body: {}, ok: t('marketing.queued_note') })}>{t('marketing.actions.regenerate')}</Button> : null}
            {canManage && !p.is_example && access.hasFeature('feature.campaigns') ? <Button size="sm" variant="ghost" loading={busy === 'camp'} onClick={() => act('camp', `/marketing/plans/${id}/campaign-draft`, { body: {}, ok: t('marketing.rec.created_campaign') })}>{t('marketing.actions.to_campaign')}</Button> : null}
          </div>
          {mode === 'diff' ? <VersionDiff planId={id} versions={p.versions.map((x: any) => x.version)} />
            : mode === 'edit' ? <PlanEditor key={p.versions[0].id} planId={id} version={p.versions[0]} onDone={() => setMode('view')} />
              : <PlanContentView v={v} locale={locale} />}
          <Provenance v={v} />
          <Card title={<span className="inline-flex items-center gap-2"><MessageSquare className="size-4" aria-hidden />{t('marketing.plan.comments')}</span>}>
            {p.comments.length ? (
              <ul className="mb-3 flex flex-col gap-2 text-sm">
                {p.comments.map((c: any) => <li key={c.id}><span className="font-medium">{c.author}</span> <span className="text-xs text-ink-muted">{formatDateTime(c.created_at, { locale, tz: access.timezone })}</span><p dir="auto">{c.body}</p></li>)}
              </ul>
            ) : <p className="mb-3 text-sm text-ink-muted">{t('marketing.plan.no_comments')}</p>}
            {canManage ? (
              <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (comment.trim() && await act('comment', `/marketing/plans/${id}/comments`, { body: { body: comment.trim(), plan_version_id: v.id } })) setComment(''); }}>
                <label className="sr-only" htmlFor="plan-comment">{t('marketing.actions.add_comment')}</label>
                <Input id="plan-comment" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
                <Button type="submit" variant="outline" loading={busy === 'comment'}>{t('marketing.actions.add_comment')}</Button>
              </form>
            ) : null}
          </Card>
        </div>
      )}
    </Drawer>
  );
}

function Provenance({ v }: { v: any }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const flags: string[] = v.validation?.flags ?? [];
  const rejected = v.validation?.rejected_recommendations?.length ?? 0;
  return (
    <Card title={t('marketing.plan.provenance')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <SourceBadge source={v.source} />
        {v.provider ? <span className="font-mono text-xs" dir="ltr">{v.provider} / {v.model} / {v.prompt_version}</span> : null}
        {v.data_as_of ? <span className="text-xs text-ink-muted">{t('marketing.plan.data_as_of', { time: formatDateTime(v.data_as_of, { locale, tz: access.timezone }) })}</span> : null}
        {v.input_tokens != null ? <span className="text-xs text-ink-muted">{t('marketing.plan.tokens', { in: v.input_tokens, out: v.output_tokens ?? 0 })}</span> : null}
      </div>
      {flags.length ? <p className="mt-2 text-xs text-warn">{t('marketing.plan.flags')}: {flags.join(', ')}</p> : null}
      {rejected ? <p className="mt-1 text-xs text-warn">{t('marketing.plan.rejected_recs', { n: rejected })}</p> : null}
    </Card>
  );
}

function PlanContentView({ v, locale }: { v: any; locale: 'ar' | 'en' }) {
  const { t } = useI18n();
  const access = useAccess();
  const c = v.content;
  return (
    <div className="flex flex-col gap-3">
      {c.experimental ? <Alert tone="warn">{t('marketing.plan.experimental')}</Alert> : null}
      <Card title={t('marketing.plan.goal')}><p dir="auto">{c.goal}</p>
        {c.monthly_goals?.length && v.content.initiatives.length === 0 ? <ul className="mt-2 list-disc ps-5 text-sm">{c.monthly_goals.map((g: any) => <li key={g.id} dir="auto">{g.title}</li>)}</ul> : null}
      </Card>
      {c.baseline.length ? (
        <Card title={t('marketing.plan.baseline')}>
          <dl className="grid gap-2 sm:grid-cols-2">{c.baseline.map((b: any) => <div key={b.metric_key}><dt className="text-xs text-ink-muted">{metricLabel(t, b.metric_key, b.label)}</dt><dd className="font-semibold tabular-nums" dir="ltr">{fmtMetric(b.metric_key, b.value)}</dd></div>)}</dl>
        </Card>
      ) : null}
      {c.initiatives.length ? (
        <Card title={t('marketing.plan.initiatives')}>
          <ul className="flex flex-col gap-2 text-sm">{c.initiatives.map((i: any) => <li key={i.id}><p className="font-medium" dir="auto">{i.title}</p><p className="text-ink-muted" dir="auto">{i.description}</p>{i.evidence_refs.length ? <p className="font-mono text-[11px] text-ink-muted" dir="ltr">{i.evidence_refs.join(', ')}</p> : null}</li>)}</ul>
        </Card>
      ) : null}
      <Card title={t('marketing.plan.activities')}>
        {c.activities.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-xs text-ink-muted"><tr><th scope="col" className="text-start">{t('marketing.plan.title')}</th><th scope="col" className="text-start">{t('marketing.plan.dates')}</th><th scope="col" className="text-start">{t('marketing.plan.channel')}</th><th scope="col" className="text-start">{t('marketing.plan.capacity_note')}</th><th scope="col" className="text-start">{t('marketing.plan.linked_goal')}</th></tr></thead>
              <tbody>{c.activities.map((a: any) => (
                <tr key={a.id} className="border-t border-line align-top">
                  <td className="py-2 pe-2"><p dir="auto">{a.title}</p>{a.content_idea ? <p className="text-xs text-ink-muted" dir="auto">{a.content_idea}</p> : null}</td>
                  <td className="py-2 pe-2 text-xs" dir="ltr">{a.date_from ?? '—'}{a.date_to && a.date_to !== a.date_from ? ` → ${a.date_to}` : ''}</td>
                  <td className="py-2 pe-2 text-xs">{a.channel ?? '—'}</td>
                  <td className="py-2 pe-2 text-xs">{a.capacity_note ?? '—'}</td>
                  <td className="py-2 text-xs">{c.monthly_goals?.find((g: any) => g.id === a.monthly_goal_ref)?.title ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
      </Card>
      <div className="grid gap-3 sm:grid-cols-2">
        <Card title={t('marketing.plan.budget')}>
          <p className="text-sm">{c.budget.amount_minor !== null ? formatMoney(c.budget.amount_minor, access.currency, locale) : '—'} • {t(`marketing.plan.budget_status.${c.budget.status}`)}</p>
          {c.budget.assumptions ? <p className="text-xs text-ink-muted" dir="auto">{c.budget.assumptions}</p> : null}
        </Card>
        <Card title={t('marketing.plan.metrics')}>
          <ul className="flex flex-col gap-1 text-sm">{c.metrics.map((m: any) => <li key={m.key}>{metricLabel(t, m.key, m.label)}: <span dir="ltr">{fmtMetric(m.key, m.baseline)}</span>{m.proposed_target !== null ? <> → <span title={t('marketing.plan.target_note')}>{t('marketing.plan.proposed_target')} <span dir="ltr">{fmtMetric(m.key, m.proposed_target)}</span></span></> : null}</li>)}</ul>
          <p className="mt-2 text-xs text-ink-muted">{t('marketing.plan.target_note')}</p>
        </Card>
      </div>
      {c.limitations ? <Card title={t('marketing.plan.limitations')}><p className="text-sm text-ink-muted" dir="auto">{c.limitations}</p></Card> : null}
    </div>
  );
}

const RATIO_KEY = /occupancy|rate|ratio|share/;
function fmtMetric(key: string, v: number | null) {
  if (v === null || v === undefined) return '—';
  return RATIO_KEY.test(key) && Math.abs(v) <= 1.5 ? `${Math.round(v * 1000) / 10}%` : String(v);
}
function metricLabel(t: (k: string) => string, key: string, fallback: string) {
  const k = `marketing.metric.${key.replace(/\./g, '_')}`;
  const v = t(k);
  return v === k ? fallback || key : v;
}

function PlanEditor({ planId, version, onDone }: { planId: string; version: any; onDone: () => void }) {
  const { t } = useI18n();
  const { act, busy } = useAct();
  const [c, setC] = useState(() => structuredClone(version.content));
  const [note, setNote] = useState('');
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesWarning(dirty);
  const setAct = (i: number, patch: Record<string, unknown>) => { setC((x: any) => ({ ...x, activities: x.activities.map((a: any, j: number) => (j === i ? { ...a, ...patch } : a)) })); setDirty(true); };
  return (
    <Card title={t('marketing.plan.edit_title')}>
      <form className="flex flex-col gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (await act('save', `/marketing/plans/${planId}/versions`, { body: { base_version: version.version, content: c, ...(note ? { change_note: note } : {}) }, ok: t('states.saved') })) { setDirty(false); onDone(); }
      }}>
        <Field label={t('marketing.plan.goal')}>{(p) => <Textarea {...p} maxLength={500} value={c.goal} onChange={(e) => { setC({ ...c, goal: e.target.value }); setDirty(true); }} />}</Field>
        {c.activities.map((a: any, i: number) => (
          <fieldset key={a.id} className="grid gap-2 rounded-lg border border-line p-2 sm:grid-cols-4">
            <legend className="px-1 text-xs text-ink-muted">{t('marketing.plan.activities')} {i + 1}</legend>
            <Field label={t('marketing.plan.title')} className="sm:col-span-2">{(p) => <Input {...p} maxLength={200} value={a.title} onChange={(e) => setAct(i, { title: e.target.value })} />}</Field>
            <Field label={t('analytics.period.from')}>{(p) => <Input {...p} type="date" dir="ltr" value={a.date_from ?? ''} onChange={(e) => setAct(i, { date_from: e.target.value || null })} />}</Field>
            <Field label={t('analytics.period.to')}>{(p) => <Input {...p} type="date" dir="ltr" value={a.date_to ?? ''} onChange={(e) => setAct(i, { date_to: e.target.value || null })} />}</Field>
            <Field label={t('marketing.plan.content_idea')} className="sm:col-span-4">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={a.content_idea ?? ''} onChange={(e) => setAct(i, { content_idea: e.target.value || null })} />}</Field>
          </fieldset>
        ))}
        <Field label={t('marketing.plan.limitations')}>{(p) => <Textarea {...p} maxLength={2000} value={c.limitations} onChange={(e) => { setC({ ...c, limitations: e.target.value }); setDirty(true); }} />}</Field>
        <Field label={t('marketing.plan.change_note')}>{(p) => <Input {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onDone}>{t('actions.cancel')}</Button><Button type="submit" loading={busy === 'save'}>{t('marketing.actions.save_version')}</Button></div>
      </form>
    </Card>
  );
}

function VersionDiff({ planId, versions }: { planId: string; versions: number[] }) {
  const { t } = useI18n();
  const access = useAccess();
  const [from, setFrom] = useState(versions[1] ?? versions[0]!);
  const [to, setTo] = useState(versions[0]!);
  const r = useApiQuery<any>(loomKey(access.slug, 'diff', planId, String(from), String(to)), access.api(`/marketing/plans/${planId}/diff?from=${from}&to=${to}`));
  const show = (x: unknown) => (typeof x === 'object' ? JSON.stringify(x) : String(x));
  return (
    <Card title={t('marketing.plan.diff_title')}>
      <div className="mb-3 flex gap-2">
        <Field label={t('marketing.plan.from_version')} className="w-32">{(p) => <Select {...p} value={from} onChange={(e) => setFrom(Number(e.target.value))}>{versions.map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>
        <Field label={t('marketing.plan.to_version')} className="w-32">{(p) => <Select {...p} value={to} onChange={(e) => setTo(Number(e.target.value))}>{versions.map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>
      </div>
      {r.isLoading ? <LoadingState rows={2} /> : r.error ? <ErrorState error={r.error} /> : !r.data.changes.length ? <p className="text-sm text-ink-muted">{t('marketing.plan.no_changes')}</p> : (
        <ul className="flex flex-col gap-2 text-sm">
          {r.data.changes.map((c: any, i: number) => (
            <li key={i} className="rounded-lg border border-line p-2">
              <p className="font-mono text-xs" dir="ltr">{c.path}</p>
              <Badge tone={c.kind === 'added' ? 'ok' : c.kind === 'removed' ? 'danger' : 'info'}>{t(`marketing.plan.${c.kind}`)}</Badge>
              {c.before !== undefined ? <p className="mt-1 text-xs text-danger line-through" dir="auto">{show(c.before).slice(0, 400)}</p> : null}
              {c.after !== undefined ? <p className="mt-1 text-xs text-ok" dir="auto">{show(c.after).slice(0, 400)}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
