'use client';

import { useMemo, useState } from 'react';
import { Bot, CalendarCheck, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney, WEEKDAYS } from '@/shared/format';
import { useApiQuery, useUnsavedChangesWarning } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, DeniedState, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, Input, MoneyInput, Select, Switch, Textarea } from '../components/form';
import { Card, DataTable, PageHeader, Tabs } from '../components/layout';
import { JobStatus, loomKey, PlanStatus, useAct } from './loom-shared';
import { LoomPlans } from './LoomPlans';
import { LoomRecommendations } from './LoomRecommendations';
import { LoomTrends } from './LoomTrends';
import { LoomCampaigns } from './LoomCampaigns';

type Tab = 'summary' | 'plans' | 'recommendations' | 'trends' | 'campaigns' | 'preferences' | 'jobs';
const TABS: Tab[] = ['summary', 'plans', 'recommendations', 'trends', 'campaigns', 'preferences', 'jobs'];

export function LoomDashboard({ initialTab }: { initialTab?: string }) {
  const { t } = useI18n();
  const access = useAccess();
  const [tab, setTab] = useState<Tab>(TABS.includes(initialTab as Tab) ? (initialTab as Tab) : 'summary');
  if (!access.can('marketing.view', 'marketing.manage')) return <DeniedState />;
  const change = (v: Tab) => {
    setTab(v);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', v);
    window.history.replaceState(null, '', u.toString());
  };
  return (
    <div>
      <PageHeader title={t('marketing.title')} subtitle={t('marketing.subtitle')} />
      <Tabs value={tab} onChange={change} items={TABS.map((v) => ({ value: v, label: t(`marketing.tabs.${v}`) }))} />
      {tab === 'summary' ? <Summary onNavigate={change} /> : tab === 'plans' ? <LoomPlans /> : tab === 'recommendations' ? <LoomRecommendations />
        : tab === 'trends' ? <LoomTrends /> : tab === 'campaigns' ? <LoomCampaigns /> : tab === 'preferences' ? <Preferences /> : <Jobs />}
    </div>
  );
}

export function AiStatusCard({ ai }: { ai: any }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Bot className="size-5 text-luma-500" aria-hidden />{ai.state === 'connected' ? t('marketing.ai.connected') : ai.state === 'disconnected' ? t('marketing.ai.disconnected') : t('marketing.ai.misconfigured')}</span>}>
      {ai.state === 'disconnected' ? <p className="text-sm text-ink-muted">{t(`marketing.ai.reason_${ai.reason}`)}</p> : null}
      {ai.state === 'connected' ? <p className="text-sm text-ink-muted">{ai.verified_at ? t('marketing.ai.verified_at', { time: formatDateTime(ai.verified_at, { locale, tz: access.timezone }) }) : t('marketing.ai.not_verified')}</p> : null}
      {!ai.feature_enabled ? <p className="text-sm text-warn">{t('marketing.ai.feature_off')}</p> : null}
      <p className="mt-1 text-sm">{ai.budget.limit === null ? t('marketing.ai.budget_unlimited', { used: ai.budget.used }) : t('marketing.ai.budget', { used: ai.budget.used, limit: ai.budget.limit })}</p>
      <p className="mt-2 text-xs text-ink-muted">{t('marketing.ai.honest_note')}</p>
    </Card>
  );
}

function Summary({ onNavigate }: { onNavigate: (t: Tab) => void }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const r = useApiQuery<any>(loomKey(access.slug, 'summary'), access.api('/marketing/summary'), { refetchInterval: 20000 });
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const canManage = access.can('marketing.manage');
  const request = (kind: string, mode?: 'rules') => act(`${kind}${mode ?? ''}`, '/marketing/jobs', { body: { kind, ...(mode ? { mode } : {}) }, ok: t('marketing.queued_note') });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <AiStatusCard ai={d.ai} />
        <Card title={t('marketing.summary.top_recs')} actions={<Button size="sm" variant="ghost" onClick={() => onNavigate('recommendations')}>{t('marketing.summary.view_all')}</Button>}>
          {d.top_recommendations.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {d.top_recommendations.map((x: any) => (
                <li key={x.id} className="flex items-start justify-between gap-2"><span dir="auto">{x.title}</span><Badge>{t(`marketing.rec.category.${x.category}`)}</Badge></li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-muted">{t('marketing.summary.no_recs')}</p>}
          <p className="mt-2 text-xs text-ink-muted">{t('marketing.summary.open_recs', { n: d.open_recommendations })}</p>
        </Card>
        <Card title={t('marketing.summary.plans_now')} actions={<Button size="sm" variant="ghost" onClick={() => onNavigate('plans')}>{t('marketing.summary.view_all')}</Button>}>
          {d.plans.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {d.plans.map((p: any) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span dir="auto">{p.title} <span className="text-xs text-ink-muted">({t(`marketing.kinds.${p.kind}`)})</span></span>
                  {p.is_example ? <Badge tone="warn">{t('marketing.plan.example_badge')}</Badge> : <PlanStatus status={p.status} />}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-muted">{t('marketing.summary.no_plans')}</p>}
        </Card>
      </div>
      {canManage ? (
        <Card>
          <div className="flex flex-wrap gap-2">
            <Button icon={<Sparkles className="size-4" />} loading={busy === 'monthly_plan'} onClick={() => request('monthly_plan')}>{t('marketing.actions.generate_monthly')}</Button>
            <Button variant="secondary" loading={busy === 'weekly_plan'} onClick={() => request('weekly_plan')}>{t('marketing.actions.generate_weekly')}</Button>
            <Button variant="outline" loading={busy === 'recommendations'} onClick={() => request('recommendations')}>{t('marketing.actions.generate_recs')}</Button>
            {d.ai.state !== 'connected' ? <Button variant="ghost" loading={busy === 'monthly_planrules'} onClick={() => request('monthly_plan', 'rules')}>{t('marketing.actions.rules_plan')}</Button> : null}
            <Button variant="ghost" loading={busy === 'example'} onClick={() => act('example', '/marketing/plans/example', { body: { kind: 'monthly' } }).then((x) => x && onNavigate('plans'))}>{t('marketing.actions.example_plan')}</Button>
          </div>
        </Card>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('marketing.summary.recent_jobs')} actions={<Button size="sm" variant="ghost" onClick={() => onNavigate('jobs')}>{t('marketing.summary.view_all')}</Button>}>
          {d.recent_jobs.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {d.recent_jobs.map((j: any) => (
                <li key={j.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t(`marketing.kinds.${j.kind}`)}</span><JobStatus status={j.status} />
                  {j.error_code ? <span className="w-full text-xs text-ink-muted">{t(`marketing.job_errors.${j.error_code}`)}</span> : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-muted">{t('marketing.jobs.empty')}</p>}
        </Card>
        <Card title={t('marketing.tabs.trends')}>
          <p className="text-sm">{t('marketing.summary.trends_open', { n: d.trends.open })} • {t('marketing.summary.sources_active', { n: d.trends.active_sources })}</p>
          <p className="mt-2 text-sm text-ink-muted">{d.calendar.verified_events ? t('marketing.summary.calendar_n', { n: d.calendar.verified_events }) : t('marketing.summary.calendar_none')}</p>
        </Card>
        <Card title={t('marketing.summary.channels')}>
          <ul className="flex flex-col gap-1 text-sm">
            {Object.entries(d.channels).map(([ch, st]) => (
              <li key={ch} className="flex justify-between gap-2"><span>{t(`marketing.campaigns.channel.${ch}`)}</span><Badge tone={st === 'connected' ? 'ok' : st === 'dev_simulation' ? 'warn' : 'neutral'}>{t(`marketing.campaigns.channel_status.${String(st)}`)}</Badge></li>
            ))}
          </ul>
          {!d.campaigns_enabled ? <p className="mt-2 text-xs text-ink-muted">{t('marketing.campaigns.not_in_plan')}</p> : null}
        </Card>
      </div>
    </div>
  );
}

function Jobs() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const r = useApiQuery<any[]>(loomKey(access.slug, 'jobs'), access.api('/marketing/jobs'), { refetchInterval: 10000 });
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const canManage = access.can('marketing.manage');
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="info">{t('marketing.jobs.explanation')}</Alert>
      {!r.data!.length ? <EmptyState title={t('marketing.jobs.empty')} /> : (
        <DataTable rows={r.data!} rowKey={(j: any) => j.id} caption={t('marketing.tabs.jobs')} columns={[
          { key: 'k', header: t('marketing.jobs.kind'), cell: (j: any) => t(`marketing.kinds.${j.kind}`) },
          { key: 'p', header: t('marketing.jobs.period'), cell: (j: any) => <span dir="ltr">{j.period_key}</span> },
          { key: 's', header: t('marketing.jobs.status'), cell: (j: any) => <JobStatus status={j.status} /> },
          { key: 'a', header: t('marketing.jobs.attempts'), cell: (j: any) => `${j.attempts}/${j.max_attempts}` },
          { key: 'e', header: t('marketing.jobs.error'), cell: (j: any) => (j.error_code ? t(`marketing.job_errors.${j.error_code}`) : '—') },
          { key: 'c', header: t('marketing.jobs.created'), cell: (j: any) => formatDateTime(j.created_at, { locale, tz: access.timezone }) },
          { key: 'x', header: '', cell: (j: any) => (canManage && ['failed', 'unavailable', 'insufficient_data'].includes(j.status) && j.kind !== 'employee_insights' ? (
            <div className="flex gap-1">
              <Button size="sm" variant="outline" loading={busy === `r${j.id}`} onClick={() => act(`r${j.id}`, `/marketing/jobs/${j.id}/retry`, { body: {} })}>{t('marketing.actions.retry')}</Button>
              {j.kind !== 'trend_assessment' ? <Button size="sm" variant="ghost" loading={busy === `rr${j.id}`} onClick={() => act(`rr${j.id}`, `/marketing/jobs/${j.id}/retry`, { body: { mode: 'rules' } })}>{t('marketing.actions.retry_rules')}</Button> : null}
            </div>
          ) : null) },
        ]} />
      )}
    </div>
  );
}

const CHANNELS = ['in_app', 'whatsapp', 'sms', 'email', 'instagram', 'tiktok', 'snapchat', 'storefront'] as const;

function Preferences() {
  const access = useAccess();
  const r = useApiQuery<any>(loomKey(access.slug, 'prefs'), access.api('/marketing/preferences'));
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  return <PreferencesForm initial={r.data} />;
}

function PreferencesForm({ initial }: { initial: any }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const [form, setForm] = useState<any>(initial);
  const [goalsText, setGoalsText] = useState<string>(((initial.goals ?? []) as string[]).join('\n'));
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesWarning(dirty);
  const canManage = access.can('marketing.manage');
  const set = (patch: Record<string, unknown>) => { setForm((f: any) => ({ ...f, ...patch })); setDirty(true); };
  const body = useMemo(() => form && ({
    goals: goalsText.split('\n').map((g) => g.trim()).filter(Boolean).slice(0, 10), monthly_budget_minor: form.monthly_budget_minor, max_discount_bp: form.max_discount_bp,
    tone: form.tone || null, brand_style: form.brand_style || null, channels: form.channels, audience_notes: form.audience_notes || null, photography_resources: form.photography_resources || null,
    schedule_enabled: form.schedule_enabled, weekly_enabled: form.weekly_enabled, monthly_enabled: form.monthly_enabled, weekly_weekday: Number(form.weekly_weekday),
    monthly_day: Number(form.monthly_day), local_hour: Number(form.local_hour), promote_products: form.promote_products,
  }), [form, goalsText]);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title={t('marketing.prefs.title')} className="lg:col-span-2">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act('prefs', '/marketing/preferences', { method: 'PUT', body, ok: t('states.saved') })) setDirty(false); }}>
          <Field label={t('marketing.prefs.goals')} hint={t('marketing.prefs.goals_hint')} className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} value={goalsText} disabled={!canManage} onChange={(e) => { setGoalsText(e.target.value); setDirty(true); }} />}</Field>
          <Field label={t('marketing.prefs.budget')}>{(p) => <MoneyInput {...p} value={form.monthly_budget_minor} disabled={!canManage} onChange={(v) => set({ monthly_budget_minor: v })} />}</Field>
          <Field label={t('marketing.prefs.max_discount')}>{(p) => <Input {...p} type="number" min={0} max={100} dir="ltr" disabled={!canManage} value={form.max_discount_bp / 100} onChange={(e) => set({ max_discount_bp: Math.round(Math.min(100, Math.max(0, Number(e.target.value) || 0)) * 100) })} />}</Field>
          <Field label={t('marketing.prefs.tone')}>{(p) => <Input {...p} maxLength={200} disabled={!canManage} value={form.tone ?? ''} onChange={(e) => set({ tone: e.target.value })} />}</Field>
          <Field label={t('marketing.prefs.brand_style')}>{(p) => <Input {...p} maxLength={300} disabled={!canManage} value={form.brand_style ?? ''} onChange={(e) => set({ brand_style: e.target.value })} />}</Field>
          <Field label={t('marketing.prefs.audience_notes')}>{(p) => <Textarea {...p} maxLength={1000} disabled={!canManage} value={form.audience_notes ?? ''} onChange={(e) => set({ audience_notes: e.target.value })} />}</Field>
          <Field label={t('marketing.prefs.photography')}>{(p) => <Textarea {...p} maxLength={1000} disabled={!canManage} value={form.photography_resources ?? ''} onChange={(e) => set({ photography_resources: e.target.value })} />}</Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">{t('marketing.prefs.channels')}</legend>
            <div className="flex flex-wrap gap-3">
              {CHANNELS.map((c) => (
                <Checkbox key={c} disabled={!canManage} label={['email', 'sms', 'whatsapp', 'in_app'].includes(c) ? t(`marketing.campaigns.channel.${c}`) : c}
                  checked={form.channels.includes(c)} onChange={(v) => set({ channels: v ? [...form.channels, c] : form.channels.filter((x: string) => x !== c) })} />
              ))}
            </div>
          </fieldset>
          <div className="sm:col-span-2"><Checkbox disabled={!canManage} label={t('marketing.prefs.promote_products')} checked={form.promote_products} onChange={(v) => set({ promote_products: v })} /></div>
          <fieldset className="grid gap-3 rounded-xl border border-line p-3 sm:col-span-2 sm:grid-cols-3">
            <legend className="px-1 text-sm font-medium">{t('marketing.prefs.schedule')}</legend>
            <div className="sm:col-span-3"><Switch disabled={!canManage} label={t('marketing.prefs.schedule')} checked={form.schedule_enabled} onChange={(v) => set({ schedule_enabled: v })} /><p className="text-xs text-ink-muted">{t('marketing.prefs.schedule_hint')} ({form.timezone})</p></div>
            <Checkbox disabled={!canManage} label={t('marketing.prefs.weekly')} checked={form.weekly_enabled} onChange={(v) => set({ weekly_enabled: v })} />
            <Checkbox disabled={!canManage} label={t('marketing.prefs.monthly')} checked={form.monthly_enabled} onChange={(v) => set({ monthly_enabled: v })} />
            <span />
            <Field label={t('marketing.prefs.weekday')}>{(p) => <Select {...p} disabled={!canManage} value={form.weekly_weekday} onChange={(e) => set({ weekly_weekday: Number(e.target.value) })}>{WEEKDAYS[locale].map((w, i) => <option key={w} value={i}>{w}</option>)}</Select>}</Field>
            <Field label={t('marketing.prefs.month_day')}>{(p) => <Input {...p} type="number" min={1} max={28} dir="ltr" disabled={!canManage} value={form.monthly_day} onChange={(e) => set({ monthly_day: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })} />}</Field>
            <Field label={t('marketing.prefs.hour')}>{(p) => <Input {...p} type="number" min={0} max={23} dir="ltr" disabled={!canManage} value={form.local_hour} onChange={(e) => set({ local_hour: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })} />}</Field>
          </fieldset>
          <p className="text-xs text-ink-muted sm:col-span-2">{t('marketing.prefs.city')}: {form.city ?? t('states.unknown')} • {t('marketing.prefs.branches')}: {form.branches.map((b: any) => b.name).join('، ') || '—'}</p>
          {canManage ? <div className="flex justify-end sm:col-span-2"><Button type="submit" loading={busy === 'prefs'}>{t('actions.save')}</Button></div> : null}
        </form>
      </Card>
      <CalendarCard />
      {form.monthly_budget_minor !== null ? <p className="text-xs text-ink-muted lg:col-span-3">{t('marketing.prefs.budget')}: {formatMoney(form.monthly_budget_minor, access.currency, locale)}</p> : null}
    </div>
  );
}

function CalendarCard() {
  const { t } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const r = useApiQuery<any[]>(loomKey(access.slug, 'calendar'), access.api('/marketing/calendar'));
  const [ev, setEv] = useState({ title: '', kind: 'holiday', starts_on: '', ends_on: '', relevance_note: '', source_url: '' });
  const canManage = access.can('marketing.manage');
  return (
    <Card title={<span className="inline-flex items-center gap-2"><CalendarCheck className="size-5 text-luma-500" aria-hidden />{t('marketing.prefs.calendar_title')}</span>}>
      <p className="mb-2 text-xs text-ink-muted">{t('marketing.prefs.calendar_hint')}</p>
      {r.isLoading ? <LoadingState rows={2} /> : r.error ? <ErrorState error={r.error} /> : r.data!.length ? (
        <ul className="mb-3 flex flex-col gap-2 text-sm">
          {r.data!.map((e: any) => (
            <li key={e.id} className="flex items-center justify-between gap-2">
              <span dir="auto">{e.title} <span className="text-xs text-ink-muted" dir="ltr">{e.starts_on} → {e.ends_on}</span></span>
              {canManage ? <Button size="sm" variant="ghost" aria-label={t('marketing.actions.delete')} loading={busy === e.id} onClick={() => act(e.id, `/marketing/calendar/${e.id}`, { method: 'DELETE', body: undefined })}><Trash2 className="size-4" /></Button> : null}
            </li>
          ))}
        </ul>
      ) : <p className="mb-3 text-sm text-ink-muted">{t('marketing.prefs.calendar_none')}</p>}
      {canManage ? (
        <form className="flex flex-col gap-2" onSubmit={async (e) => {
          e.preventDefault();
          const body = { title: ev.title, kind: ev.kind, starts_on: ev.starts_on, ends_on: ev.ends_on || ev.starts_on, ...(ev.relevance_note ? { relevance_note: ev.relevance_note } : {}), ...(ev.source_url ? { source_url: ev.source_url } : {}) };
          if (await act('cal', '/marketing/calendar', { body })) setEv({ title: '', kind: 'holiday', starts_on: '', ends_on: '', relevance_note: '', source_url: '' });
        }}>
          <Field label={t('marketing.prefs.event_title')} required>{(p) => <Input {...p} required maxLength={120} value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} />}</Field>
          <Field label={t('marketing.prefs.kind')}>{(p) => <Select {...p} value={ev.kind} onChange={(e) => setEv({ ...ev, kind: e.target.value })}>{['holiday', 'season', 'local_event', 'business_event'].map((k) => <option key={k} value={k}>{t(`marketing.prefs.event_kind.${k}`)}</option>)}</Select>}</Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('marketing.prefs.starts')} required>{(p) => <Input {...p} required type="date" dir="ltr" value={ev.starts_on} onChange={(e) => setEv({ ...ev, starts_on: e.target.value })} />}</Field>
            <Field label={t('marketing.prefs.ends')}>{(p) => <Input {...p} type="date" dir="ltr" value={ev.ends_on} onChange={(e) => setEv({ ...ev, ends_on: e.target.value })} />}</Field>
          </div>
          <Field label={t('marketing.prefs.relevance')}>{(p) => <Input {...p} maxLength={500} value={ev.relevance_note} onChange={(e) => setEv({ ...ev, relevance_note: e.target.value })} />}</Field>
          <Field label={t('marketing.prefs.source_url')}>{(p) => <Input {...p} type="url" dir="ltr" pattern="https://.*" value={ev.source_url} onChange={(e) => setEv({ ...ev, source_url: e.target.value })} />}</Field>
          <Button type="submit" variant="outline" icon={<Plus className="size-4" />} loading={busy === 'cal'}>{t('marketing.actions.add_event')}</Button>
        </form>
      ) : null}
    </Card>
  );
}
