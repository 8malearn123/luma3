'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/shared/format';
import { api } from '../../api';
import { useApiQuery, useErrorMessage } from '../../hooks';
import { Button } from '../../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Field, Input } from '../../components/form';
import { Card } from '../../components/layout';
import { useToast } from '../../components/toast';
import { useStepUp } from '../stepup';

/**
 * /platform/loom — platform calendar review (phase 4): import the curated
 * starter calendar or the official registry sources (configured in the
 * settings above), see each source's fetch state, and verify / withdraw /
 * restore events. Estimated dates stay «يحتاج تحقق» until verified with a note.
 */
export function LoomCalendarAdmin() {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useApiQuery<any>(['platform', 'loom', 'calendar'], '/api/v1/platform/loom/calendar');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  if (q.isLoading) return <LoadingState rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const run = async (key: string, path: string, method: string, body: unknown) => {
    setBusy(key);
    try {
      await stepUp(() => api(path, { method, body }));
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform', 'loom', 'calendar'] });
    } catch (e) { toast({ tone: 'danger', text: msg(e) }); } finally { setBusy(null); }
  };
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('loom.radar.admin.title')} actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" loading={busy === 'starter'} onClick={() => run('starter', '/api/v1/platform/loom/calendar', 'POST', { target: 'starter' })}>{t('loom.radar.admin.import_starter')}</Button>
          <Button size="sm" variant="outline" loading={busy === 'sources'} onClick={() => run('sources', '/api/v1/platform/loom/calendar', 'POST', { target: 'sources' })}>{t('loom.radar.admin.import_sources')}</Button>
        </div>
      }>
        <p className="text-sm text-ink-muted">{t('loom.radar.admin.subtitle')}</p>
        <h3 className="mt-3 text-sm font-medium">{t('loom.radar.admin.sources_state')}</h3>
        <ul className="mt-1 flex flex-col gap-1 text-sm">{d.sources.map((s: any) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.name}</span>
            <Badge tone={!s.enabled ? 'neutral' : s.state?.status === 'ok' ? 'ok' : s.state?.status === 'error' ? 'danger' : 'warn'}>{s.state?.status ?? 'pending'}</Badge>
            <span className="text-xs text-ink-muted">{s.state?.last_success_at ? `${formatDateTime(s.state.last_success_at, { locale })} · ${t('loom.radar.admin.imported', { n: s.state.imported_count })}` : t('loom.radar.admin.never')}{s.state?.last_error ? ` · ${s.state.last_error}` : ''}</span>
          </li>
        ))}</ul>
      </Card>
      <Card>
        {!d.events.length ? <EmptyState title={t('loom.radar.admin.empty')} /> : (
          <ul className="flex flex-col gap-2">{d.events.map((e: any) => (
            <li key={e.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium" dir="auto">{locale === 'ar' ? e.title.ar : e.title.en}</span>
                {e.untrusted ? <span className="text-xs text-ink-muted">({t('loom.radar.untrusted')})</span> : null}
                <Badge tone={e.verification === 'verified' ? 'ok' : 'warn'}>{t(`loom.radar.calendar.${e.verification}`)}</Badge>
                <Badge>{t(`loom.radar.calendar.kind.${e.kind}`)}</Badge>
                <Badge>{t(`loom.radar.admin.origin.${e.origin}`)}</Badge>
                <Badge>{t(`loom.radar.admin.basis.${e.date_basis}`)}</Badge>
                {e.status === 'withdrawn' ? <Badge tone="danger">{t('loom.radar.admin.withdrawn')}</Badge> : null}
                <span className="text-xs text-ink-muted" dir="ltr">{e.region} · {e.starts_on}{e.ends_on !== e.starts_on ? ` → ${e.ends_on}` : ''}</span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">{t('loom.radar.calendar.source', { name: e.source_name })}{e.verification_note ? ` · ${e.verification_note}` : ''}</p>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                {e.needs_verification ? (
                  <>
                    <Field label={t('loom.radar.admin.verify_note')} className="min-w-64">{(p) => <Input {...p} maxLength={500} value={note[e.id] ?? ''} onChange={(x) => setNote({ ...note, [e.id]: x.target.value })} />}</Field>
                    <Button size="sm" variant="outline" disabled={(note[e.id] ?? '').trim().length < 5} loading={busy === `v${e.id}`} onClick={() => run(`v${e.id}`, `/api/v1/platform/loom/calendar/${e.id}`, 'PATCH', { action: 'verify', note: note[e.id] })}>{t('loom.radar.admin.verify')}</Button>
                  </>
                ) : null}
                {e.status === 'active'
                  ? <Button size="sm" variant="ghost" loading={busy === `w${e.id}`} onClick={() => run(`w${e.id}`, `/api/v1/platform/loom/calendar/${e.id}`, 'PATCH', { action: 'withdraw' })}>{t('loom.radar.admin.withdraw')}</Button>
                  : <Button size="sm" variant="ghost" loading={busy === `r${e.id}`} onClick={() => run(`r${e.id}`, `/api/v1/platform/loom/calendar/${e.id}`, 'PATCH', { action: 'restore' })}>{t('loom.radar.admin.restore')}</Button>}
              </div>
            </li>
          ))}</ul>
        )}
      </Card>
    </div>
  );
}
