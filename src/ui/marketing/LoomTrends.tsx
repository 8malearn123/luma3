'use client';

import { useState } from 'react';
import { ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDate, formatDateTime } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, Input, Select } from '../components/form';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';
import { loomKey, useAct } from './loom-shared';

export function LoomTrends() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const { act, busy } = useAct();
  const r = useApiQuery<any>(loomKey(access.slug, 'trends'), access.api('/marketing/trends'));
  const [src, setSrc] = useState({ kind: 'rss', name: '', url: '', access_basis: '' });
  const canManage = access.can('marketing.manage');
  if (r.isLoading) return <LoadingState rows={4} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const reportFetch = (f: any) => toast({ tone: f.ok ? 'ok' : 'danger', text: f.ok ? t('marketing.trends.add_result', { stored: f.stored, duplicates: f.duplicates, stale: f.stale_skipped }) : t('marketing.trends.add_failed', { code: f.error }) });
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">{t('marketing.trends.note_not_news')}</Alert>
      {d.sources_status === 'none' ? <Alert tone="warn">{t('marketing.trends.no_sources')}</Alert> : d.sources_status === 'all_unavailable' ? <Alert tone="warn">{t('marketing.trends.sources_unavailable')}</Alert> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3 lg:col-span-2">
          {!d.cards.length ? <EmptyState title={t('marketing.trends.cards_empty')} /> : d.cards.map((c: any) => (
            <Card key={c.id} title={<span dir="auto">{c.what_is_happening}</span>}>
              <div className="flex flex-wrap gap-2">
                <Badge tone={c.evidence_strength === 'quantified' ? 'ok' : c.evidence_strength === 'early_signal' ? 'info' : 'neutral'}>{t('marketing.trends.evidence_label')}: {t(`marketing.trends.evidence.${c.evidence_strength}`)}</Badge>
                <Badge tone={c.fit === 'good' ? 'ok' : c.fit === 'partial' ? 'warn' : 'neutral'}>{t('marketing.trends.fit_label')}: {t(`marketing.trends.fit.${c.fit}`)}</Badge>
                {c.valid_until ? <Badge>{t('marketing.trends.valid_until', { date: c.valid_until })}</Badge> : null}
              </div>
              <p className="mt-2 text-sm" dir="auto">{c.fit_explanation}</p>
              {c.application_idea ? <p className="mt-1 text-sm" dir="auto"><span className="font-medium">{t('marketing.trends.idea')}:</span> {c.application_idea}</p> : null}
              <p className="mt-1 text-xs text-ink-muted">{t('marketing.trends.time_cost', { time: c.est_time ?? '—', cost: c.est_cost ?? '—' })}</p>
              <p className="mt-3 text-xs font-medium">{t('marketing.trends.observations')}</p>
              <ul className="mt-1 flex flex-col gap-1 text-xs">
                {c.observations.map((o: any) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-2">
                    <a href={o.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 underline" dir="auto">{o.title}<ExternalLink className="size-3" aria-hidden /></a>
                    <span className="text-ink-muted">{o.source_name}</span>
                    <span className="text-ink-muted">{o.published_at ? formatDate(o.published_at, { locale, tz: access.timezone }) : '—'}</span>
                    <Badge>{t(`marketing.trends.freshness.${o.freshness}`)}</Badge>
                  </li>
                ))}
              </ul>
              {canManage ? (
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" loading={busy === `add${c.id}`} onClick={() => act(`add${c.id}`, `/marketing/trends/${c.id}/add-to-plan`, { ok: t('marketing.trends.added_to_plan') })}>{t('marketing.actions.add_to_plan')}</Button>
                  <Button size="sm" variant="ghost" loading={busy === `dis${c.id}`} onClick={() => act(`dis${c.id}`, `/marketing/trends/${c.id}/dismiss`)}>{t('marketing.actions.dismiss')}</Button>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
        <Card title={t('marketing.trends.sources')}>
          {d.sources.length ? (
            <ul className="mb-3 flex flex-col gap-3 text-sm">
              {d.sources.map((s: any) => (
                <li key={s.id} className="rounded-lg border border-line p-2">
                  <div className="flex items-center justify-between gap-2"><span className="font-medium" dir="auto">{s.name}</span><Badge tone={s.status === 'active' ? 'ok' : s.status === 'error' ? 'danger' : 'neutral'}>{t(`marketing.trends.source_status.${s.status}`)}</Badge></div>
                  <p className="truncate font-mono text-[11px] text-ink-muted" dir="ltr">{s.url}</p>
                  <p className="text-xs text-ink-muted">{s.last_fetched_at ? t('marketing.trends.last_fetched', { time: formatDateTime(s.last_fetched_at, { locale, tz: access.timezone }) }) : t('marketing.trends.never_fetched')}{s.last_error ? ` • ${t('marketing.trends.last_error', { code: s.last_error })}` : ''}</p>
                  {canManage ? (
                    <div className="mt-1 flex gap-1">
                      {s.status !== 'disabled' ? <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy === `f${s.id}`} onClick={async () => { const x = await act<any>(`f${s.id}`, `/marketing/trends/sources/${s.id}/fetch`); if (x) reportFetch(x.fetch); }}>{t('marketing.actions.fetch_now')}</Button> : null}
                      <Button size="sm" variant="ghost" loading={busy === `s${s.id}`} onClick={() => act(`s${s.id}`, `/marketing/trends/sources/${s.id}`, { method: 'PATCH', body: { status: s.status === 'disabled' ? 'active' : 'disabled' } })}>{s.status === 'disabled' ? t('marketing.actions.enable') : t('marketing.actions.disable')}</Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p className="mb-3 text-sm text-ink-muted">{t('marketing.trends.no_sources')}</p>}
          {canManage ? (
            <form className="flex flex-col gap-2" onSubmit={async (e) => {
              e.preventDefault();
              const x = await act<any>('src', '/marketing/trends/sources', { body: src });
              if (x) { reportFetch(x.fetch); setSrc({ kind: 'rss', name: '', url: '', access_basis: '' }); }
            }}>
              <Field label={t('marketing.trends.kind')}>{(p) => <Select {...p} value={src.kind} onChange={(e) => setSrc({ ...src, kind: e.target.value })}><option value="rss">{t('marketing.trends.kind_rss')}</option><option value="user_link">{t('marketing.trends.kind_user_link')}</option></Select>}</Field>
              <Field label={t('marketing.trends.name')} required>{(p) => <Input {...p} required maxLength={120} value={src.name} onChange={(e) => setSrc({ ...src, name: e.target.value })} />}</Field>
              <Field label={t('marketing.trends.url')} required>{(p) => <Input {...p} required type="url" dir="ltr" pattern="https://.*" maxLength={500} value={src.url} onChange={(e) => setSrc({ ...src, url: e.target.value })} />}</Field>
              <Field label={t('marketing.trends.access_basis')} hint={t('marketing.trends.access_hint')} required>{(p) => <Input {...p} required maxLength={300} value={src.access_basis} onChange={(e) => setSrc({ ...src, access_basis: e.target.value })} />}</Field>
              <Button type="submit" variant="outline" icon={<Plus className="size-4" />} loading={busy === 'src'}>{t('marketing.actions.add_source')}</Button>
            </form>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
