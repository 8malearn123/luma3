'use client';

import { useState } from 'react';
import { CalendarDays, ExternalLink, Link2, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDate, formatDateTime, formatMoney } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, Input, Select, Textarea } from '../components/form';
import { Card, Tabs } from '../components/layout';
import { useToast } from '../components/toast';
import { loomKey, useAct } from './loom-shared';

/**
 * Loom radar tab (phase 4): signals grouped by cluster, the calendar of
 * relevant occasions, market observations and source connections. External
 * text is shown as untrusted (dir=auto, labelled), never as instructions.
 */
type Sub = 'signals' | 'calendar' | 'market' | 'sources';
const EVIDENCE_TONE: Record<string, 'neutral' | 'info' | 'ok'> = { example: 'neutral', early_signal: 'info', supported_trend: 'ok' };
const FRESH_TONE: Record<string, 'ok' | 'info' | 'warn' | 'neutral'> = { fresh: 'ok', aging: 'info', stale: 'warn', unknown: 'neutral' };
const CONN_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = { connected: 'ok', disconnected: 'warn', error: 'danger', disabled: 'neutral' };
const pct = (x: number) => Math.round(x * 100);

export function LoomTrends() {
  const { t } = useI18n();
  const [sub, setSub] = useState<Sub>('signals');
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">{t('loom.radar.note')}</Alert>
      <Tabs value={sub} onChange={setSub} items={(['signals', 'calendar', 'market', 'sources'] as Sub[]).map((v) => ({ value: v, label: t(`loom.radar.tabs.${v}`) }))} />
      {sub === 'signals' ? <Signals /> : sub === 'calendar' ? <Calendar /> : sub === 'market' ? <Market /> : <Sources />}
    </div>
  );
}

/** Open internal opportunities (the only things external items may be attached to). */
function useOpenOpportunities() {
  const access = useAccess();
  const q = useApiQuery<any[]>(loomKey(access.slug, 'opportunities', 'radar-open'), access.api('/loom/opportunities'));
  return (q.data ?? []).filter((o) => ['detected', 'assessed', 'proposed', 'studying', 'accepted', 'deferred'].includes(o.status))
    .map((o) => ({ id: o.card.opportunity_id as string, title: o.card.title as string }));
}

function AttachPicker({ suggested, disabled, onAttach, busy }: { suggested?: string | null; disabled?: boolean; onAttach: (id: string) => void; busy: boolean }) {
  const { t } = useI18n();
  const opps = useOpenOpportunities();
  const [sel, setSel] = useState<string>('');
  const value = sel || suggested || '';
  if (!opps.length) return <p className="text-xs text-ink-muted">{t('loom.radar.no_opportunity')}</p>;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={t('loom.radar.choose_opportunity')} className="min-w-56">{(p) => (
        <Select {...p} value={value} disabled={disabled} onChange={(e) => setSel(e.target.value)}>
          <option value="">—</option>
          {opps.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </Select>
      )}</Field>
      <Button size="sm" variant="outline" icon={<Link2 className="size-3.5" />} disabled={disabled || !value} loading={busy} onClick={() => onAttach(value)}>{t('loom.radar.actions.attach')}</Button>
    </div>
  );
}

function Signals() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const r = useApiQuery<any>(loomKey(access.slug, 'radar'), access.api('/loom/radar'));
  const canManage = access.can('marketing.manage');
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const decide = (id: string, body: Record<string, unknown>, ok?: string) => act(`${body.action}${id}`, `/loom/radar/clusters/${id}`, { body, ok });
  return (
    <div className="flex flex-col gap-3">
      {d.external_status !== 'connected' ? <Alert tone="warn">{t(`loom.radar.external.${d.external_status}`)}</Alert> : null}
      {!d.clusters.length ? <EmptyState title={t('loom.radar.empty')} /> : d.clusters.map((c: any) => (
        <Card key={c.id} title={<span className="inline-flex flex-col gap-1"><span dir="auto">{c.untrusted_label}</span><span className="inline-flex items-center gap-1 text-xs font-normal text-ink-muted"><ShieldAlert className="size-3" aria-hidden />{t('loom.radar.untrusted')}</span></span>}>
          <div className="flex flex-wrap gap-2">
            <Badge tone={EVIDENCE_TONE[c.evidence_class]}>{t('loom.radar.evidence_label')}: {t(`loom.radar.evidence.${c.evidence_class}`)}</Badge>
            {c.valid_until ? <Badge>{t('loom.radar.valid_until', { date: c.valid_until })}</Badge> : null}
            <Badge>{t('loom.radar.counts', { stories: c.signal_count, sources: c.source_count })}</Badge>
            {c.relevance ? <Badge tone={c.relevance.score >= 0.6 ? 'ok' : 'neutral'}>{t('loom.radar.relevance', { score: pct(c.relevance.score) })}</Badge> : null}
            {c.planned_ref ? <Badge tone="brand">{t('loom.radar.planned')}</Badge> : null}
          </div>
          <p className="mt-1 text-xs text-ink-muted">{t(`loom.radar.evidence_hint.${c.evidence_class}`)}</p>
          {c.relevance ? (
            <details className="mt-2 text-sm"><summary className="cursor-pointer text-xs font-medium">{t('loom.radar.relevance_why')}</summary>
              <ul className="mt-1 list-disc ps-5 text-xs text-ink-muted">{c.relevance.reasons.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
            </details>
          ) : null}
          <p className="mt-2 text-sm">
            {c.attached_opportunity ? t('loom.radar.attached', { title: c.attached_opportunity.title }) : c.suggested_opportunity ? t('loom.radar.suggested', { title: c.suggested_opportunity.title }) : t('loom.radar.no_opportunity')}
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {c.signals.map((o: any) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2">
                <a href={o.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 underline" dir="auto">{o.untrusted_title}<ExternalLink className="size-3" aria-hidden /></a>
                <span className="text-ink-muted">{o.source_name}</span>
                <span className="text-ink-muted">{o.published_at ? formatDate(o.published_at, { locale, tz: access.timezone }) : '—'}</span>
                <Badge tone={FRESH_TONE[o.freshness]}>{t(`loom.radar.freshness.${o.freshness}`)}</Badge>
                {o.reach_metrics ? <span className="font-mono text-[11px] text-ink-muted" dir="ltr">{Object.entries(o.reach_metrics).map(([k, v]) => `${k}: ${v}`).join(' · ')}</span> : null}
              </li>
            ))}
          </ul>
          {canManage ? (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              {c.attached_opportunity ? (
                <>
                  <Button size="sm" variant="outline" loading={busy === `add_to_plan${c.id}`} onClick={() => decide(c.id, { action: 'add_to_plan' }, t('loom.radar.added_to_plan'))}>{t('loom.radar.actions.add_to_plan')}</Button>
                  <Button size="sm" variant="ghost" loading={busy === `detach${c.id}`} onClick={() => decide(c.id, { action: 'detach' })}>{t('loom.radar.actions.detach')}</Button>
                </>
              ) : <AttachPicker suggested={c.suggested_opportunity?.id} busy={busy === `attach${c.id}`} onAttach={(id) => decide(c.id, { action: 'attach', opportunity_id: id }, t('loom.radar.attached_ok'))} />}
              <Button size="sm" variant="ghost" loading={busy === `dismiss${c.id}`} onClick={() => decide(c.id, { action: 'dismiss' })}>{t('loom.radar.actions.dismiss')}</Button>
            </div>
          ) : null}
        </Card>
      ))}
      {d.stale.length ? (
        <details className="rounded-2xl border border-line bg-white p-4 text-sm"><summary className="cursor-pointer font-medium">{t('loom.radar.stale_title')} ({d.stale.length})</summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-muted">{d.stale.map((c: any) => <li key={c.id} className="flex gap-2"><span dir="auto">{c.untrusted_label}</span><Badge tone="warn">{t('loom.radar.freshness.stale')}</Badge></li>)}</ul>
        </details>
      ) : null}
      {d.dismissed.length ? (
        <details className="rounded-2xl border border-line bg-white p-4 text-sm"><summary className="cursor-pointer font-medium">{t('loom.radar.dismissed_title')} ({d.dismissed.length})</summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs">{d.dismissed.map((c: any) => (
            <li key={c.id} className="flex items-center gap-2"><span dir="auto">{c.untrusted_label}</span>{canManage ? <Button size="sm" variant="ghost" loading={busy === `reopen${c.id}`} onClick={() => decide(c.id, { action: 'reopen' })}>{t('loom.radar.actions.reopen')}</Button> : null}</li>
          ))}</ul>
        </details>
      ) : null}
    </div>
  );
}

function Calendar() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const [showHidden, setShowHidden] = useState(false);
  const r = useApiQuery<any[]>(loomKey(access.slug, 'radar', 'calendar'), access.api('/loom/radar/calendar'));
  const canManage = access.can('marketing.manage');
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const items = (r.data ?? []).filter((e) => showHidden || e.choice !== 'hidden');
  const months = [...new Set(items.map((e) => e.starts_on.slice(0, 7)))];
  const post = (e: any, body: Record<string, unknown>, ok?: string) => act(`${body.action}${e.id}`, `/loom/radar/calendar/${e.id}`, { body: { ...body, ...(['attach', 'detach', 'add_to_plan'].includes(String(body.action)) ? { origin: e.origin === 'owner_calendar' ? 'owner' : 'platform' } : {}) }, ok });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end"><Checkbox label={t('loom.radar.calendar.show_hidden')} checked={showHidden} onChange={setShowHidden} /></div>
      {!items.length ? <EmptyState title={t('loom.radar.calendar.empty')} /> : months.map((m) => (
        <Card key={m} title={<span className="inline-flex items-center gap-2"><CalendarDays className="size-4" aria-hidden />{formatDate(`${m}-01`, { locale })}</span>}>
          <ul className="flex flex-col gap-3">
            {items.filter((e) => e.starts_on.startsWith(m)).map((e) => (
              <li key={e.ref} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium" dir="auto">{e.title}</span>
                  {e.title_is_untrusted ? <span className="text-xs text-ink-muted">({t('loom.radar.untrusted')})</span> : null}
                  <Badge tone={e.verification === 'verified' ? 'ok' : 'warn'}>{t(`loom.radar.calendar.${e.verification}`)}</Badge>
                  {e.awareness_only ? <Badge tone="info">{t('loom.radar.calendar.awareness_only')}</Badge> : null}
                  <Badge>{t(`loom.radar.calendar.kind.${e.kind}`)}</Badge>
                  {e.origin === 'owner_calendar' ? <Badge tone="brand">{t('loom.radar.calendar.owner')}</Badge> : e.choice ? <Badge tone={e.choice === 'adopted' ? 'ok' : 'neutral'}>{t(`loom.radar.calendar.${e.choice}`)}</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-ink-muted" dir="ltr">{e.starts_on}{e.ends_on !== e.starts_on ? ` → ${e.ends_on}` : ''}</p>
                {e.verification !== 'verified' ? <p className="mt-1 text-xs text-warn">{t('loom.radar.calendar.needs_verification_hint')}</p> : null}
                {e.awareness_only ? <p className="mt-1 text-xs text-ink-muted">{t('loom.radar.calendar.awareness_hint')}</p> : null}
                {e.origin === 'platform_calendar' ? <p className="mt-1 text-xs text-ink-muted">{t('loom.radar.calendar.source', { name: e.source.name })}{e.source.url ? <> · <a className="underline" href={e.source.url} target="_blank" rel="noopener noreferrer nofollow" dir="ltr">{e.source.url}</a></> : null}</p> : null}
                {e.relevance ? (
                  <details className="mt-1 text-xs"><summary className="cursor-pointer">{t('loom.radar.relevance', { score: pct(e.relevance.score) })}</summary>
                    <ul className="list-disc ps-5 text-ink-muted">{e.relevance.reasons.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
                  </details>
                ) : null}
                {canManage ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    {e.origin === 'platform_calendar' ? (
                      <>
                        {e.choice !== 'adopted' ? <Button size="sm" variant="outline" loading={busy === `adopt${e.id}`} onClick={() => post(e, { action: 'adopt' })}>{t('loom.radar.actions.adopt')}</Button> : null}
                        {e.choice !== 'hidden' ? <Button size="sm" variant="ghost" loading={busy === `hide${e.id}`} onClick={() => post(e, { action: 'hide' })}>{t('loom.radar.actions.hide')}</Button> : null}
                        {e.choice ? <Button size="sm" variant="ghost" loading={busy === `reset${e.id}`} onClick={() => post(e, { action: 'reset' })}>{t('loom.radar.actions.reset')}</Button> : null}
                      </>
                    ) : null}
                    {e.attached_opportunity_ids.length ? (
                      <>
                        <Button size="sm" variant="outline" loading={busy === `add_to_plan${e.id}`} onClick={() => post(e, { action: 'add_to_plan' }, t('loom.radar.added_to_plan'))}>{t('loom.radar.actions.add_to_plan')}</Button>
                        <Button size="sm" variant="ghost" loading={busy === `detach${e.id}`} onClick={() => post(e, { action: 'detach' })}>{t('loom.radar.actions.detach')}</Button>
                      </>
                    ) : <AttachPicker suggested={e.relevance?.opportunity_id} disabled={e.verification !== 'verified'} busy={busy === `attach${e.id}`} onAttach={(id) => post(e, { action: 'attach', opportunity_id: id }, t('loom.radar.attached_ok'))} />}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

const KINDS = ['competitor_offer', 'price_point', 'audience_need', 'channel_norm'] as const;
const COMP = ['comparable', 'partial', 'not_comparable'] as const;
const REASONS = ['different_duration', 'different_components', 'different_quality', 'different_region', 'different_audience', 'unknown_details'] as const;

function Market() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const { act, busy } = useAct();
  const r = useApiQuery<any>(loomKey(access.slug, 'radar', 'market'), access.api('/loom/market-observations'));
  const empty = { kind: 'price_point', offering_id: '', competitor: '', price: '', note: '', observed_on: new Date().toISOString().slice(0, 10), region: '', comparability: 'comparable', reasons: [] as string[], source: 'manual', source_url: '' };
  const [f, setF] = useState(empty);
  const canManage = access.can('marketing.manage');
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const money = (m: number | null) => (m === null ? '—' : formatMoney(m, 'SAR', locale));
  const hasPrice = f.kind === 'competitor_offer' || f.kind === 'price_point';
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-3 lg:col-span-2">
        <Alert tone="info">{t('loom.radar.market.context_note')}</Alert>
        {d.price_context.length ? (
          <Card title={t('loom.radar.market.title')}>
            <ul className="flex flex-col gap-1 text-sm">{d.price_context.map((p: any) => (
              <li key={p.offering_id}>{t('loom.radar.market.price_context', { name: d.offerings.find((o: any) => o.id === p.offering_id)?.name ?? '—', ours: money(p.our_price_minor), median: money(p.median_comparable_minor), n: p.comparable_prices, position: t(`loom.radar.market.position.${p.position}`) })}</li>
            ))}</ul>
          </Card>
        ) : null}
        {!d.observations.length ? <EmptyState title={t('loom.radar.market.empty')} /> : d.observations.map((o: any) => (
          <Card key={o.id}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{t(`loom.radar.market.kind.${o.kind}`)}</Badge>
              <Badge tone={o.comparability === 'comparable' ? 'ok' : o.comparability === 'partial' ? 'info' : 'warn'}>{t(`loom.radar.market.comparability.${o.comparability}`)}</Badge>
              {o.offering_name ? <span className="text-sm font-medium">{o.offering_name}</span> : null}
              {o.competitor ? <span className="text-sm" dir="auto">{o.competitor}</span> : null}
              {o.price_minor !== null ? <span className="text-sm">{money(o.price_minor)}</span> : null}
              <span className="text-xs text-ink-muted" dir="ltr">{o.observed_on}{o.region ? ` · ${o.region}` : ''}</span>
            </div>
            <p className="mt-1 text-sm" dir="auto">{o.note}</p>
            {o.comparability_reasons.length ? <p className="mt-1 text-xs text-ink-muted">{o.comparability_reasons.map((x: string) => t(`loom.radar.market.reasons.${x}`)).join('، ')}</p> : null}
            {o.source_url ? <p className="mt-1 text-xs"><a className="underline" href={o.source_url} target="_blank" rel="noopener noreferrer nofollow" dir="ltr">{o.source_url}</a></p> : null}
            {o.link_status === 'fetched' && o.untrusted_title ? <p className="mt-1 text-xs text-ink-muted" dir="auto">{t('loom.radar.market.link_fetched', { title: o.untrusted_title })}</p> : o.link_status === 'unreachable' ? <p className="mt-1 text-xs text-warn">{t('loom.radar.market.link_unreachable')}</p> : null}
            {canManage ? <div className="mt-2"><Button size="sm" variant="ghost" loading={busy === `arch${o.id}`} onClick={() => act(`arch${o.id}`, `/loom/market-observations/${o.id}`, { method: 'PATCH', body: { archived: true } })}>{t('loom.radar.actions.archive')}</Button></div> : null}
          </Card>
        ))}
      </div>
      {canManage ? (
        <Card title={t('loom.radar.actions.add_observation')}>
          <form className="flex flex-col gap-2" onSubmit={async (e) => {
            e.preventDefault();
            const body = {
              kind: f.kind, offering_id: f.offering_id || null, competitor: f.competitor || null, note: f.note, price_minor: hasPrice && f.price ? Math.round(Number(f.price) * 100) : null,
              observed_on: f.observed_on, region: f.region || null, comparability: f.comparability, comparability_reasons: f.comparability === 'comparable' ? [] : f.reasons,
              source: f.source, source_url: f.source === 'link' ? f.source_url : null,
            };
            const x = await act<any>('obs', '/loom/market-observations', { body });
            if (x) { setF(empty); if (x.link_status === 'unreachable') toast({ tone: 'info', text: t('loom.radar.market.link_unreachable') }); }
          }}>
            <Field label={t('loom.radar.market.fields.kind')}>{(p) => <Select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{t(`loom.radar.market.kind.${k}`)}</option>)}</Select>}</Field>
            <Field label={t('loom.radar.market.fields.offering')}>{(p) => <Select {...p} value={f.offering_id} onChange={(e) => setF({ ...f, offering_id: e.target.value })}><option value="">{t('loom.radar.market.fields.none')}</option>{d.offerings.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>
            <Field label={t('loom.radar.market.fields.competitor')}>{(p) => <Input {...p} maxLength={120} value={f.competitor} onChange={(e) => setF({ ...f, competitor: e.target.value })} />}</Field>
            {hasPrice ? <Field label={t('loom.radar.market.fields.price')}>{(p) => <Input {...p} type="number" dir="ltr" min={0} step="0.01" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />}</Field> : null}
            <Field label={t('loom.radar.market.fields.note')} required>{(p) => <Textarea {...p} required minLength={2} maxLength={1000} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
            <Field label={t('loom.radar.market.fields.observed_on')} required>{(p) => <Input {...p} type="date" dir="ltr" required value={f.observed_on} onChange={(e) => setF({ ...f, observed_on: e.target.value })} />}</Field>
            <Field label={t('loom.radar.market.fields.region')}>{(p) => <Input {...p} maxLength={40} value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} />}</Field>
            <Field label={t('loom.radar.market.fields.comparability')}>{(p) => <Select {...p} value={f.comparability} onChange={(e) => setF({ ...f, comparability: e.target.value })}>{COMP.map((k) => <option key={k} value={k}>{t(`loom.radar.market.comparability.${k}`)}</option>)}</Select>}</Field>
            {f.comparability !== 'comparable' ? (
              <fieldset className="flex flex-col gap-1"><legend className="mb-1 text-sm font-medium">{t('loom.radar.market.fields.reasons')}</legend>
                {REASONS.map((k) => <Checkbox key={k} label={t(`loom.radar.market.reasons.${k}`)} checked={f.reasons.includes(k)} onChange={(v) => setF({ ...f, reasons: v ? [...f.reasons, k] : f.reasons.filter((x) => x !== k) })} />)}
              </fieldset>
            ) : null}
            <Field label={t('loom.radar.market.fields.source')}>{(p) => <Select {...p} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="manual">{t('loom.radar.market.fields.manual')}</option><option value="link">{t('loom.radar.market.fields.link')}</option></Select>}</Field>
            {f.source === 'link' ? <Field label={t('loom.radar.market.fields.url')} required>{(p) => <Input {...p} type="url" dir="ltr" required pattern="https://.*" maxLength={500} value={f.source_url} onChange={(e) => setF({ ...f, source_url: e.target.value })} />}</Field> : null}
            <Button type="submit" variant="outline" icon={<Plus className="size-4" />} loading={busy === 'obs'}>{t('loom.radar.actions.add_observation')}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function Sources() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const { act, busy } = useAct();
  const r = useApiQuery<any>(loomKey(access.slug, 'radar'), access.api('/loom/radar'));
  const [src, setSrc] = useState({ kind: 'rss', name: '', url: '', provider: 'search_interest', q: '', access_basis: '' });
  const canManage = access.can('marketing.manage');
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const report = (f: any) => toast({ tone: f.ok ? 'ok' : 'danger', text: f.ok ? t('loom.radar.fetch_result', { stored: f.stored, duplicates: f.duplicates, stale: f.stale_skipped }) : t('loom.radar.fetch_failed', { code: f.error }) });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-3 lg:col-span-2">
        <Card title={t('loom.radar.sources.providers')}>
          <ul className="flex flex-col gap-2 text-sm">{d.providers.map((p: any) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2"><span className="font-medium">{p.label}</span><Badge tone={CONN_TONE[p.status.state]}>{t(`loom.radar.sources.connection.${p.status.state}`)}</Badge>
              {p.status.state === 'disconnected' ? <span className="text-xs text-ink-muted">{t('loom.radar.sources.not_configured')}</span> : null}</li>
          ))}</ul>
        </Card>
        <Card title={t('loom.radar.sources.title')}>
          {!d.sources.length ? <p className="text-sm text-ink-muted">{t('loom.radar.sources.empty')}</p> : (
            <ul className="flex flex-col gap-3 text-sm">{d.sources.map((s: any) => (
              <li key={s.id} className="rounded-lg border border-line p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium" dir="auto">{s.name}</span>
                  <span className="flex gap-1"><Badge>{t(`loom.radar.sources.kind.${s.kind}`)}</Badge><Badge tone={CONN_TONE[s.connection]}>{t(`loom.radar.sources.connection.${s.connection}`)}</Badge></span>
                </div>
                {s.url ? <p className="truncate font-mono text-[11px] text-ink-muted" dir="ltr">{s.url}</p> : null}
                {s.connection === 'disconnected' ? <p className="text-xs text-warn">{t('loom.radar.sources.not_configured')}</p> : null}
                <p className="text-xs text-ink-muted">{s.last_fetched_at ? t('loom.radar.sources.last_fetched', { time: formatDateTime(s.last_fetched_at, { locale, tz: access.timezone }) }) : t('loom.radar.sources.never')}
                  {s.last_error ? ` • ${s.last_error}` : ''}{s.consecutive_failures ? ` • ${t('loom.radar.sources.failures', { n: s.consecutive_failures })}` : ''}</p>
                {canManage ? (
                  <div className="mt-1 flex gap-1">
                    {s.status !== 'disabled' ? <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy === `f${s.id}`} onClick={async () => { const x = await act<any>(`f${s.id}`, `/loom/radar/sources/${s.id}/fetch`); if (x) report(x.fetch); }}>{t('loom.radar.actions.fetch')}</Button> : null}
                    <Button size="sm" variant="ghost" loading={busy === `s${s.id}`} onClick={() => act(`s${s.id}`, `/loom/radar/sources/${s.id}`, { method: 'PATCH', body: { status: s.status === 'disabled' ? 'active' : 'disabled' } })}>{s.status === 'disabled' ? t('loom.radar.actions.enable') : t('loom.radar.actions.disable')}</Button>
                  </div>
                ) : null}
              </li>
            ))}</ul>
          )}
        </Card>
      </div>
      {canManage ? (
        <Card title={t('loom.radar.actions.add_source')}>
          <form className="flex flex-col gap-2" onSubmit={async (e) => {
            e.preventDefault();
            const body = src.kind === 'api' ? { kind: 'api', name: src.name, provider: src.provider, query: src.q ? { q: src.q } : {}, access_basis: src.access_basis } : { kind: src.kind, name: src.name, url: src.url, access_basis: src.access_basis };
            const x = await act<any>('src', '/loom/radar/sources', { body });
            if (x) { report(x.fetch); setSrc({ ...src, name: '', url: '', q: '', access_basis: '' }); }
          }}>
            <Field label={t('loom.radar.sources.fields.kind')}>{(p) => <Select {...p} value={src.kind} onChange={(e) => setSrc({ ...src, kind: e.target.value })}>{['rss', 'user_link', 'api'].map((k) => <option key={k} value={k}>{t(`loom.radar.sources.kind.${k}`)}</option>)}</Select>}</Field>
            <Field label={t('loom.radar.sources.fields.name')} required>{(p) => <Input {...p} required minLength={2} maxLength={120} value={src.name} onChange={(e) => setSrc({ ...src, name: e.target.value })} />}</Field>
            {src.kind === 'api' ? (
              <>
                <Field label={t('loom.radar.sources.fields.provider')}>{(p) => <Select {...p} value={src.provider} onChange={(e) => setSrc({ ...src, provider: e.target.value })}>{d.providers.map((x: any) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>}</Field>
                <Field label={t('loom.radar.sources.fields.query')}>{(p) => <Input {...p} maxLength={120} value={src.q} onChange={(e) => setSrc({ ...src, q: e.target.value })} />}</Field>
              </>
            ) : <Field label={t('loom.radar.sources.fields.url')} required>{(p) => <Input {...p} required type="url" dir="ltr" pattern="https://.*" maxLength={500} value={src.url} onChange={(e) => setSrc({ ...src, url: e.target.value })} />}</Field>}
            <Field label={t('loom.radar.sources.fields.access_basis')} required>{(p) => <Input {...p} required minLength={2} maxLength={300} value={src.access_basis} onChange={(e) => setSrc({ ...src, access_basis: e.target.value })} />}</Field>
            <Button type="submit" variant="outline" icon={<Plus className="size-4" />} loading={busy === 'src'}>{t('loom.radar.actions.add_source')}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
