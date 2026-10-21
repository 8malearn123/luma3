'use client';

import { useState } from 'react';
import { Plus, Trash2, Users } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney } from '@/shared/format';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, Input, Select, Textarea } from '../components/form';
import { Card, DataTable } from '../components/layout';
import { Drawer } from '../components/overlay';
import { CampaignStatus, loomKey, useAct } from './loom-shared';

type Cond = { type: string; [k: string]: unknown };
const COND_TYPES = ['tag', 'has_consent', 'last_visit_before_days', 'last_visit_within_days', 'visited_service', 'not_visited_service', 'due_for_service', 'min_visits', 'never_booked', 'has_account'] as const;
const CHANNELS = ['in_app', 'email', 'sms', 'whatsapp'] as const;

function defaultCond(type: string): Cond {
  switch (type) {
    case 'last_visit_before_days': case 'last_visit_within_days': return { type, days: 60 };
    case 'visited_service': case 'not_visited_service': case 'due_for_service': return { type, service_id: '' };
    case 'min_visits': return { type, count: 2 };
    case 'has_consent': return { type, channel: 'in_app' };
    case 'tag': return { type, tag: '' };
    default: return { type };
  }
}

export function LoomCampaigns() {
  const { t } = useI18n();
  const access = useAccess();
  if (!access.hasFeature('feature.campaigns')) return <Alert tone="info">{t('marketing.campaigns.not_in_plan')}</Alert>;
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">{t('marketing.campaigns.send_rules')}</Alert>
      <div className="grid gap-4 lg:grid-cols-2">
        <SegmentBuilder />
        <CampaignEditor />
      </div>
      <CampaignList />
    </div>
  );
}

function SegmentBuilder() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { act, busy } = useAct();
  const canManage = access.can('marketing.manage');
  const services = useApiQuery<any[]>(['services', access.slug], access.can('catalog.edit', 'bookings.view_all', 'bookings.manage') ? access.api('/services') : null);
  const [conds, setConds] = useState<Cond[]>([{ type: 'has_consent', channel: 'in_app' }]);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (i: number, patch: Record<string, unknown>) => { setConds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c))); setPreview(null); };
  const valid = conds.every((c) => !('service_id' in c) || c.service_id) && conds.every((c) => c.type !== 'tag' || String(c.tag).trim());
  const doPreview = async () => {
    setErr(null);
    try { setPreview(await api(access.api('/marketing/segments/preview'), { body: { definition: { conditions: conds } } })); } catch (e) { setErr(msg(e)); }
  };
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Users className="size-5 text-luma-500" aria-hidden />{t('marketing.segments.builder')}</span>}>
      <p className="mb-3 text-xs text-ink-muted">{t('marketing.segments.hint')}</p>
      <div className="flex flex-col gap-2">
        {conds.map((c, i) => (
          <div key={i} className="grid items-end gap-2 rounded-lg border border-line p-2 sm:grid-cols-[1fr_1fr_auto]">
            <Field label={t('marketing.segments.condition')}>{(p) => <Select {...p} value={c.type} onChange={(e) => { setConds((cs) => cs.map((x, j) => (j === i ? defaultCond(e.target.value) : x))); setPreview(null); }}>{COND_TYPES.map((ct) => <option key={ct} value={ct}>{t(`marketing.segments.types.${ct}`)}</option>)}</Select>}</Field>
            {'days' in c ? <Field label={t('marketing.segments.days')}>{(p) => <Input {...p} type="number" min={1} max={1095} dir="ltr" value={Number(c.days)} onChange={(e) => set(i, { days: Math.max(1, Number(e.target.value) || 1) })} />}</Field>
              : 'count' in c ? <Field label={t('marketing.segments.count')}>{(p) => <Input {...p} type="number" min={1} dir="ltr" value={Number(c.count)} onChange={(e) => set(i, { count: Math.max(1, Number(e.target.value) || 1) })} />}</Field>
                : 'channel' in c ? <Field label={t('marketing.segments.channel')}>{(p) => <Select {...p} value={String(c.channel)} onChange={(e) => set(i, { channel: e.target.value })}>{CHANNELS.map((ch) => <option key={ch} value={ch}>{t(`marketing.campaigns.channel.${ch}`)}</option>)}</Select>}</Field>
                  : 'tag' in c ? <Field label={t('marketing.segments.tag')}>{(p) => <Input {...p} maxLength={60} value={String(c.tag)} onChange={(e) => set(i, { tag: e.target.value })} />}</Field>
                    : 'service_id' in c ? <Field label={t('marketing.segments.service')}>{(p) => <Select {...p} value={String(c.service_id)} onChange={(e) => set(i, { service_id: e.target.value })}><option value="">—</option>{(services.data ?? []).map((s) => <option key={s.id} value={s.id}>{locale === 'ar' ? s.name_ar || s.name_en : s.name_en || s.name_ar}</option>)}</Select>}</Field>
                      : <span />}
            <Button size="sm" variant="ghost" aria-label={t('marketing.actions.remove')} disabled={conds.length === 1} onClick={() => { setConds((cs) => cs.filter((_, j) => j !== i)); setPreview(null); }}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} disabled={conds.length >= 10} onClick={() => setConds([...conds, defaultCond('tag')])}>{t('marketing.actions.add_condition')}</Button>
          <Button size="sm" variant="outline" disabled={!valid} onClick={doPreview}>{t('marketing.actions.preview')}</Button>
        </div>
        {err ? <Alert tone="danger">{err}</Alert> : null}
        {preview ? (
          <div className="rounded-lg bg-luma-50 p-3 text-sm" aria-live="polite">
            <p className="font-semibold">{t('marketing.segments.preview_count', { n: preview.count })}</p>
            <p className="text-xs text-ink-muted">{t('marketing.segments.consent_counts', preview.consented_by_channel)}</p>
            {preview.sample ? <p className="mt-1 text-xs text-ink-muted">{t('marketing.segments.sample_note')}: {preview.sample.map((s: any) => s.display_name).join('، ')}</p> : null}
          </div>
        ) : null}
        {canManage ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await act('seg', '/marketing/segments', { body: { name, definition: { conditions: conds } }, ok: t('states.saved') })) setName(''); }}>
            <Field label={t('marketing.segments.name')} required className="flex-1">{(p) => <Input {...p} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Button type="submit" disabled={!valid} loading={busy === 'seg'}>{t('marketing.actions.save_segment')}</Button>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

function CampaignEditor() {
  const { t } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const segs = useApiQuery<any[]>(loomKey(access.slug, 'segments'), access.api('/marketing/segments'));
  const empty = { name: '', channel: 'in_app', segment_id: '', subject: '', body: '', deep_link: '', holdout: 10, window: 14, cap: 7, qf: '21:00', qt: '09:00' };
  const [f, setF] = useState(empty);
  if (!access.can('marketing.manage')) return null;
  return (
    <Card title={t('marketing.campaigns.new')}>
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        const body = {
          name: f.name, channel: f.channel, segment_id: f.segment_id || null,
          content: { body: f.body, ...(f.subject ? { subject: f.subject } : {}), ...(f.deep_link ? { deep_link: f.deep_link } : {}) },
          holdout_bp: Math.round(f.holdout * 100), attribution_window_days: f.window, frequency_cap_days: f.cap, quiet_hours: { from: f.qf, to: f.qt },
        };
        if (await act('create', '/marketing/campaigns', { body, ok: t('marketing.rec.created_campaign') })) setF(empty);
      }}>
        <Field label={t('marketing.campaigns.name')} required className="sm:col-span-2">{(p) => <Input {...p} required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t('marketing.segments.channel')}>{(p) => <Select {...p} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{CHANNELS.map((c) => <option key={c} value={c}>{t(`marketing.campaigns.channel.${c}`)}</option>)}</Select>}</Field>
        <Field label={t('marketing.campaigns.segment')}>{(p) => <Select {...p} value={f.segment_id} onChange={(e) => setF({ ...f, segment_id: e.target.value })}><option value="">{t('marketing.segments.pick')}</option>{(segs.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <Field label={t('marketing.campaigns.subject')} className="sm:col-span-2">{(p) => <Input {...p} maxLength={150} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />}</Field>
        <Field label={t('marketing.campaigns.body')} required className="sm:col-span-2">{(p) => <Textarea {...p} required rows={3} maxLength={1500} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}</Field>
        <Field label={t('marketing.campaigns.deep_link')} className="sm:col-span-2">{(p) => <Input {...p} dir="ltr" placeholder={`/s/${access.slug}`} pattern="/[A-Za-z0-9/_\-?=&.%]*" maxLength={300} value={f.deep_link} onChange={(e) => setF({ ...f, deep_link: e.target.value })} />}</Field>
        <Field label={t('marketing.campaigns.holdout')}>{(p) => <Input {...p} type="number" min={0} max={50} dir="ltr" value={f.holdout} onChange={(e) => setF({ ...f, holdout: Math.min(50, Math.max(0, Number(e.target.value) || 0)) })} />}</Field>
        <Field label={t('marketing.campaigns.window')}>{(p) => <Input {...p} type="number" min={1} max={90} dir="ltr" value={f.window} onChange={(e) => setF({ ...f, window: Math.min(90, Math.max(1, Number(e.target.value) || 1)) })} />}</Field>
        <Field label={t('marketing.campaigns.cap')}>{(p) => <Input {...p} type="number" min={0} max={90} dir="ltr" value={f.cap} onChange={(e) => setF({ ...f, cap: Math.min(90, Math.max(0, Number(e.target.value) || 0)) })} />}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('marketing.campaigns.quiet_from')}>{(p) => <Input {...p} type="time" dir="ltr" value={f.qf} onChange={(e) => setF({ ...f, qf: e.target.value })} />}</Field>
          <Field label={t('marketing.campaigns.quiet_to')}>{(p) => <Input {...p} type="time" dir="ltr" value={f.qt} onChange={(e) => setF({ ...f, qt: e.target.value })} />}</Field>
        </div>
        <p className="text-xs text-ink-muted sm:col-span-2">{t('marketing.campaigns.approval_needed')}</p>
        <div className="flex justify-end sm:col-span-2"><Button type="submit" loading={busy === 'create'}>{t('marketing.actions.create_campaign')}</Button></div>
      </form>
    </Card>
  );
}

function CampaignList() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const [open, setOpen] = useState<string | null>(null);
  const r = useApiQuery<any[]>(loomKey(access.slug, 'campaigns'), access.api('/marketing/campaigns'), { refetchInterval: 15000 });
  return (
    <Card title={t('marketing.campaigns.title')}>
      {r.isLoading ? <LoadingState rows={3} /> : r.error ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : !r.data!.length ? <EmptyState title={t('marketing.campaigns.empty')} /> : (
        <DataTable rows={r.data!} rowKey={(c: any) => c.id} onRowClick={(c: any) => setOpen(c.id)} caption={t('marketing.campaigns.title')} columns={[
          { key: 'n', header: t('marketing.campaigns.name'), cell: (c: any) => <span dir="auto">{c.name}</span> },
          { key: 'c', header: t('marketing.segments.channel'), cell: (c: any) => t(`marketing.campaigns.channel.${c.channel}`) },
          { key: 's', header: t('fields.status'), cell: (c: any) => <CampaignStatus status={c.status} /> },
          { key: 'g', header: t('marketing.campaigns.segment'), cell: (c: any) => c.segment_name ?? '—' },
          { key: 'd', header: t('fields.date'), cell: (c: any) => formatDateTime(c.scheduled_at ?? c.created_at, { locale, tz: access.timezone }) },
        ]} />
      )}
      {open ? <CampaignDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

function CampaignDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const c = useApiQuery<any>(loomKey(access.slug, 'campaign', id), access.api(`/marketing/campaigns/${id}`));
  const res = useApiQuery<any>(loomKey(access.slug, 'campaign-results', id), access.api(`/marketing/campaigns/${id}/results`));
  const [at, setAt] = useState('');
  const canApprove = access.can('campaigns.approve');
  const canManage = access.can('marketing.manage');
  const x = c.data;
  return (
    <Drawer open onClose={onClose} wide title={x?.name ?? t('states.loading')}>
      {c.isLoading ? <LoadingState rows={4} /> : c.error ? <ErrorState error={c.error} /> : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <CampaignStatus status={x.status} />
            <Badge>{t(`marketing.campaigns.channel.${x.channel}`)}</Badge>
            <Badge tone={x.channel_status === 'connected' ? 'ok' : x.channel_status === 'dev_simulation' ? 'warn' : 'danger'}>{t(`marketing.campaigns.channel_status.${x.channel_status}`)}</Badge>
            <span className="font-mono text-xs" dir="ltr">{t('marketing.campaigns.tracking_code')}: {x.tracking_code}</span>
          </div>
          {x.last_error ? <Alert tone="danger">{t(`errors.${x.last_error}`) === `errors.${x.last_error}` ? x.last_error : t(`errors.${x.last_error}`)}</Alert> : null}
          <Card>
            {x.content.subject ? <p className="font-medium" dir="auto">{x.content.subject}</p> : null}
            <p className="whitespace-pre-line text-sm" dir="auto">{x.content.body}</p>
            {x.content.deep_link ? <p className="mt-1 font-mono text-xs" dir="ltr">{x.content.deep_link}</p> : null}
            <p className="mt-2 text-xs text-ink-muted">{t('marketing.campaigns.holdout')}: {x.holdout_bp / 100}% • {t('marketing.campaigns.window')}: {x.attribution_window_days} • {t('marketing.campaigns.cap')}: {x.frequency_cap_days} • {x.quiet_hours.from}–{x.quiet_hours.to}</p>
          </Card>
          <div className="flex flex-wrap items-end gap-2">
            {x.status === 'draft' && canApprove ? <Button loading={busy === 'approve'} onClick={() => act('approve', `/marketing/campaigns/${id}/approve`)}>{t('marketing.actions.approve')}</Button> : null}
            {x.status === 'draft' && !canApprove ? <p className="text-sm text-ink-muted">{t('marketing.campaigns.approval_needed')}</p> : null}
            {['approved', 'paused'].includes(x.status) && canApprove ? (
              <>
                <Field label={t('marketing.campaigns.schedule_at')} className="w-60">{(p) => <Input {...p} type="datetime-local" dir="ltr" value={at} onChange={(e) => setAt(e.target.value)} />}</Field>
                <Button loading={busy === 'schedule'} disabled={x.channel_status === 'disconnected'} onClick={() => act('schedule', `/marketing/campaigns/${id}/schedule`, { body: at ? { scheduled_at: new Date(at).toISOString() } : {} })}>{t('marketing.actions.schedule')}</Button>
              </>
            ) : null}
            {x.status === 'scheduled' && (canManage || canApprove) ? <Button variant="outline" loading={busy === 'pause'} onClick={() => act('pause', `/marketing/campaigns/${id}/pause`)}>{t('marketing.actions.pause')}</Button> : null}
            {['draft', 'approved', 'scheduled', 'paused'].includes(x.status) && (canManage || canApprove) ? <Button variant="danger" loading={busy === 'cancel'} onClick={() => act('cancel', `/marketing/campaigns/${id}/cancel`)}>{t('marketing.actions.cancel_campaign')}</Button> : null}
          </div>
          {x.approved_at ? <p className="text-xs text-ink-muted">{t('marketing.campaign_status.approved')}: {formatDateTime(x.approved_at, { locale, tz: access.timezone })}</p> : null}
          <Results res={res} />
        </div>
      )}
    </Drawer>
  );
}

function Results({ res }: { res: ReturnType<typeof useApiQuery<any>> }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  if (res.isLoading) return <LoadingState rows={2} />;
  if (res.error) return <ErrorState error={res.error} />;
  const d = res.data;
  if (!d.results) return <p className="text-sm text-ink-muted">{t('marketing.campaigns.results.not_started')}</p>;
  const R = d.results;
  const stats = d.stats ?? {};
  return (
    <Card title={t('marketing.campaigns.results.title')}>
      {d.disclosure.simulated_only ? <Alert tone="warn" className="mb-3">{t('marketing.campaigns.results.simulated_note')}</Alert> : null}
      <dl className="grid gap-3 sm:grid-cols-3">
        <div><dt className="text-xs text-ink-muted">{t('marketing.campaigns.audience')}</dt><dd className="font-semibold">{stats.audience ?? '—'}</dd></div>
        <div><dt className="text-xs text-ink-muted">{t('marketing.campaigns.results.delivered')}</dt><dd className="font-semibold">{R.delivered.members} • {t('marketing.campaigns.results.converters')} {R.delivered.converters} ({R.delivered.conversion_rate === null ? '—' : `${Math.round(R.delivered.conversion_rate * 100)}%`})</dd></div>
        <div><dt className="text-xs text-ink-muted">{t('marketing.campaigns.results.holdout')}</dt><dd className="font-semibold">{R.holdout.members} • {t('marketing.campaigns.results.converters')} {R.holdout.converters}</dd></div>
        <div><dt className="text-xs text-ink-muted">{t('marketing.campaigns.results.attributed')}</dt><dd className="font-semibold">{formatMoney(R.attributed_net_minor, access.currency, locale)}</dd></div>
        <div className="sm:col-span-2"><dt className="text-xs text-ink-muted">{t('marketing.campaigns.results.incremental')}</dt>
          <dd className="font-semibold">{R.incremental.status === 'estimated' ? formatMoney(R.incremental.net_minor, access.currency, locale) : <span className="font-normal text-warn">{t('marketing.campaigns.results.insufficient_sample', { n: R.incremental.min_group })}</span>}</dd></div>
      </dl>
      {stats.suppressed && Object.keys(stats.suppressed).length ? (
        <div className="mt-3"><p className="text-xs font-medium">{t('marketing.campaigns.results.suppressed')}</p>
          <div className="mt-1 flex flex-wrap gap-2">{Object.entries(stats.suppressed).map(([k, v]) => <Badge key={k}>{t(`marketing.campaigns.suppressed.${k}`)}: {String(v)}</Badge>)}</div></div>
      ) : null}
      <p className="mt-3 text-xs text-ink-muted">{t('marketing.campaigns.results.window_note', { days: d.disclosure.attribution_window_days })}</p>
      <p className="text-xs text-ink-muted">{t('marketing.campaigns.results.not_causal')}</p>
    </Card>
  );
}
