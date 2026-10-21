'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, LifeBuoy, XCircle } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Card, PageHeader, Tabs } from '../components/layout';
import { useToast } from '../components/toast';
import { When } from './common';
import { useStepUp } from './stepup';

type Grant = { id: string; reason: string; access_level: 'read' | 'write'; starts_at: string; expires_at: string; revoked_at: string | null; revoke_reason: string | null; tenant_slug: string; tenant_name: string; support_user: string; active: boolean };

export function SupportPage({ initialTenant = '' }: { initialTenant?: string }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const [slug, setSlug] = useState(initialTenant);
  const [reason, setReason] = useState('');
  const [level, setLevel] = useState<'read' | 'write'>('read');
  const [hours, setHours] = useState('2');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [created, setCreated] = useState<{ open_path: string; tenant_name: string } | null>(null);
  const list = useApiQuery<Grant[]>(['platform', 'grants', scope], `/api/v1/platform/support-grants?scope=${scope}`);

  async function create() {
    setBusy(true); setErr(null);
    try {
      const r = await stepUp(() => api<{ open_path: string; tenant_name: string }>('/api/v1/platform/support-grants', { body: { tenant_slug: slug.trim(), reason: reason.trim(), access_level: level, hours: Number(hours) } }));
      setCreated(r); setReason('');
      await qc.invalidateQueries({ queryKey: ['platform', 'grants'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setErr(null);
    try { await api(`/api/v1/platform/support-grants/${id}/revoke`, { body: {} }); toast({ tone: 'ok', text: t('platform.support.revoked') }); await qc.invalidateQueries({ queryKey: ['platform', 'grants'] }); }
    catch (e) { setErr(e); }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('platform.support.title')} subtitle={t('platform.support.subtitle')} />
      <Alert tone="info" title={t('platform.support.rules_title')}>{t('platform.support.rules')}</Alert>
      <Card title={t('platform.support.request')}>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <FormErrorSummary message={err ? msg(err) : null} issues={(err as any)?.details?.issues} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('platform.support.tenant_slug')} required>{(p) => <Input {...p} dir="ltr" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />}</Field>
            <Field label={t('platform.support.level_label')}>{(p) => <Select {...p} value={level} onChange={(e) => setLevel(e.target.value as 'read' | 'write')}><option value="read">{t('platform.support.level.read')}</option><option value="write">{t('platform.support.level.write')}</option></Select>}</Field>
            <Field label={t('platform.support.hours')} hint={t('platform.support.hours_hint')}>{(p) => <Select {...p} value={hours} onChange={(e) => setHours(e.target.value)}>{[1, 2, 4, 8, 12, 24].map((h) => <option key={h} value={h}>{t('platform.support.n_hours', { n: h })}</option>)}</Select>}</Field>
          </div>
          <Field label={t('fields.reason')} hint={t('platform.reason_hint')} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}</Field>
          <Button type="submit" className="self-start" icon={<LifeBuoy className="size-4" />} loading={busy} disabled={!slug || reason.trim().length < 10}>{t('platform.support.start')}</Button>
        </form>
        {created ? (
          <Alert tone="ok" className="mt-3" title={t('platform.support.started', { name: created.tenant_name })}>
            <a href={created.open_path} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline">{t('platform.support.open')}<ExternalLink className="size-3.5" /></a>
          </Alert>
        ) : null}
      </Card>
      <Tabs value={scope} onChange={setScope} items={[{ value: 'active', label: t('platform.support.active') }, { value: 'all', label: t('platform.support.history') }]} />
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data!.length ? <EmptyState title={t('platform.support.none')} /> : (
        <ul className="flex flex-col gap-2">
          {list.data!.map((g) => (
            <li key={g.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line bg-white p-3">
              <div className="min-w-0">
                <p className="font-medium">{g.tenant_name} <span className="text-xs text-ink-muted" dir="ltr">/{g.tenant_slug}</span></p>
                <p className="text-sm text-ink-muted">{g.reason}</p>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                  <Badge tone={g.access_level === 'write' ? 'warn' : 'info'}>{t(`platform.support.level.${g.access_level}`)}</Badge>
                  {g.active ? <Badge tone="ok">{t('platform.support.is_active')}</Badge> : g.revoked_at ? <Badge>{t('platform.support.revoked')}</Badge> : <Badge>{t('platform.support.expired')}</Badge>}
                  {g.support_user} · <When v={g.starts_at} /> → <When v={g.expires_at} />
                </p>
              </div>
              {g.active ? (
                <div className="flex gap-2">
                  <a href={`/app/${g.tenant_slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-luma-700 px-3 py-1.5 text-sm text-white hover:bg-luma-800">{t('platform.support.open')}<ExternalLink className="size-3.5" /></a>
                  <Button size="sm" variant="outline" icon={<XCircle className="size-4" />} onClick={() => revoke(g.id)}>{t('platform.support.end')}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
