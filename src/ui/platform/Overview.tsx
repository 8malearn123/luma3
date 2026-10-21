'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, CircleSlash, FlaskConical } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, PageHeader, Stat } from '../components/layout';
import { When } from './common';

type O = {
  tenants_by_status: Record<string, number>; subscriptions_by_status: Record<string, number>;
  trials_ending_soon: Array<{ id: string; trial_ends_at: string; slug: string; name: string; tenant_id: string }>;
  past_due: Array<{ id: string; grace_until: string | null; slug: string; name: string; tenant_id: string }>;
  active_support_grants: number;
  health: null | { messaging: Record<string, string>; ai: string; storage: string; failed_jobs_24h: number; outbox_pending: number; provider_events_needing_review: number; live_payment_accounts: number };
  recent_sensitive: null | Array<{ id: string; action: string; actor_name: string | null; actor_kind: string; tenant_slug: string | null; created_at: string; support_grant_id: string | null }>;
};

export function IntegrationState({ state }: { state: string }) {
  const { t } = useI18n();
  const tone = state === 'connected' ? 'ok' : state === 'dev_simulation' ? 'info' : 'warn';
  const Icon = state === 'connected' ? CheckCircle2 : state === 'dev_simulation' ? FlaskConical : CircleSlash;
  return <Badge tone={tone}><Icon className="size-3.5" aria-hidden />{t(`platform.integration_state.${state}`)}</Badge>;
}

export function PlatformOverview() {
  const { t } = useI18n();
  const q = useApiQuery<O>(['platform', 'overview'], '/api/v1/platform/overview', { refetchInterval: 60_000 });
  if (q.isLoading) return <LoadingState rows={5} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const o = q.data!;
  const total = Object.values(o.tenants_by_status).reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('platform.overview.title')} subtitle={t('platform.overview.subtitle')} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('platform.overview.tenants')} value={total} hint={['active', 'onboarding', 'suspended'].map((s) => `${t(`platform.tenant_status.${s}`)}: ${o.tenants_by_status[s] ?? 0}`).join(' · ')} />
        <Stat label={t('platform.sub_status.trialing')} value={o.subscriptions_by_status.trialing ?? 0} hint={t('platform.overview.ending_soon', { n: o.trials_ending_soon.length })} />
        <Stat label={t('platform.sub_status.past_due')} value={o.subscriptions_by_status.past_due ?? 0} tone={(o.subscriptions_by_status.past_due ?? 0) > 0 ? 'warn' : undefined} />
        <Stat label={t('platform.overview.support_grants')} value={o.active_support_grants} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('platform.overview.trials_ending')}>
          {o.trials_ending_soon.length ? (
            <ul className="divide-y divide-line text-sm">{o.trials_ending_soon.map((s) => (
              <li key={s.id} className="flex justify-between py-2"><Link className="text-luma-700 hover:underline" href={`/platform/tenants?q=${s.slug}`}>{s.name}</Link><When v={s.trial_ends_at} /></li>
            ))}</ul>
          ) : <EmptyState title={t('platform.overview.none_ending')} />}
        </Card>
        <Card title={t('platform.sub_status.past_due')}>
          {o.past_due.length ? (
            <ul className="divide-y divide-line text-sm">{o.past_due.map((s) => (
              <li key={s.id} className="flex justify-between py-2"><Link className="text-luma-700 hover:underline" href={`/platform/subscriptions?status=past_due`}>{s.name}</Link><span className="text-xs text-ink-muted">{t('platform.overview.grace_until')} <When v={s.grace_until} /></span></li>
            ))}</ul>
          ) : <EmptyState title={t('platform.overview.none_past_due')} />}
        </Card>
        {o.health ? (
          <Card title={t('platform.overview.health')} actions={<Link href="/platform/integrations" className="text-sm text-luma-700 hover:underline">{t('actions.view')}</Link>}>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              {(['email', 'sms', 'whatsapp'] as const).map((c) => <div key={c} className="flex items-center justify-between gap-2"><dt>{t(`platform.channels.${c}`)}</dt><dd><IntegrationState state={o.health!.messaging[c]!} /></dd></div>)}
              <div className="flex items-center justify-between gap-2"><dt>{t('platform.integrations.ai')}</dt><dd><IntegrationState state={o.health.ai} /></dd></div>
              <div className="flex items-center justify-between gap-2"><dt>{t('platform.integrations.failed_jobs_24h')}</dt><dd className={o.health.failed_jobs_24h ? 'font-semibold text-danger' : ''}>{o.health.failed_jobs_24h}</dd></div>
              <div className="flex items-center justify-between gap-2"><dt>{t('platform.integrations.outbox_pending')}</dt><dd>{o.health.outbox_pending}</dd></div>
              <div className="flex items-center justify-between gap-2"><dt>{t('platform.integrations.provider_review')}</dt><dd className={o.health.provider_events_needing_review ? 'font-semibold text-warn' : ''}>{o.health.provider_events_needing_review}</dd></div>
              <div className="flex items-center justify-between gap-2"><dt>{t('platform.integrations.storage')}</dt><dd>{o.health.storage}</dd></div>
            </dl>
          </Card>
        ) : null}
        {o.recent_sensitive ? (
          <Card title={t('platform.overview.recent_sensitive')} actions={<Link href="/platform/audit?sensitive_only=1" className="text-sm text-luma-700 hover:underline">{t('actions.view')}</Link>}>
            {o.recent_sensitive.length ? (
              <ul className="divide-y divide-line text-sm">{o.recent_sensitive.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2 py-2">
                  <div className="min-w-0"><p className="truncate font-mono text-xs" dir="ltr">{a.action}</p><p className="text-xs text-ink-muted">{a.actor_name ?? t(`platform.actor_kind.${a.actor_kind}`)}{a.tenant_slug ? ` · ${a.tenant_slug}` : ''}</p></div>
                  <div className="flex shrink-0 items-center gap-1 text-xs">{a.support_grant_id ? <AlertTriangle className="size-3.5 text-warn" aria-label={t('platform.audit.support_action')} /> : null}<When v={a.created_at} /></div>
                </li>
              ))}</ul>
            ) : <EmptyState />}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
