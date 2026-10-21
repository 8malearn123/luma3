'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Banknote, CheckCircle2, CircleSlash, FlaskConical, Plug, RefreshCw, Scale, Unplug } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiQuery } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { ConfirmDialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { StepUpProvider, useStepUp } from '../platform/stepup';
import { ApiErrorBox } from '../catalog/common';
import { settingsKey, type SettingsData } from './shared';

type Account = { id: string; provider: string; mode: string; status: string; enabled_methods: string[]; created_at: string };
type CatalogEntry = { name: string; integrated: boolean; note_ar: string; note_en: string };
type Reconcile = { checked: number; repaired: number; discrepancies: Array<{ payment_id: string; issue: string }> };

/** Payment provider settings. Only the LUMA Sandbox is integrated; it simulates payments and moves no real money. */
export function PaymentsSection({ slug }: { slug: string }) {
  return <StepUpProvider><Payments slug={slug} /></StepUpProvider>;
}

function Payments({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const key = ['payment-accounts', slug];
  const q = useApiQuery<{ accounts: Account[]; catalog: CatalogEntry[] }>(key, `/api/v1/t/${slug}/payment-accounts`);
  const settings = useApiQuery<SettingsData>(settingsKey(slug), access.can('business.manage') ? `/api/v1/t/${slug}/settings` : null);
  const canConfigure = access.can('payments.configure', 'business.manage') && !access.readOnly;
  const canReconcile = access.can('finance.view');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [disconnect, setDisconnect] = useState<Account | null>(null);
  const [recon, setRecon] = useState<Reconcile | null>(null);

  async function run(name: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(name); setErr(null);
    try { await stepUp(fn); toast({ tone: 'ok', text: ok }); await qc.invalidateQueries({ queryKey: key }); }
    catch (e) { if (!(e instanceof ApiError && e.code === 'reauthentication_required')) setErr(e); }
    finally { setBusy(null); }
  }

  async function reconcile() {
    setBusy('reconcile'); setErr(null);
    try { setRecon(await api<Reconcile>(`/api/v1/t/${slug}/payments/reconcile`, { body: {} })); }
    catch (e) { setErr(e); } finally { setBusy(null); }
  }

  if (q.isLoading) return <LoadingState rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { accounts, catalog } = q.data!;
  const sandbox = accounts.find((a) => a.provider === 'sandbox');
  const sandboxActive = sandbox?.status === 'active';
  const others = catalog.filter((c) => c.name !== 'sandbox');
  const policy = settings.data?.settings;

  return (
    <div className="flex flex-col gap-4">
      <ApiErrorBox err={err} />
      <Card title={t('catalog_team.payments.sandbox_title')} actions={<Badge tone="warn"><FlaskConical className="size-3" aria-hidden />{t('catalog_team.payments.simulation')}</Badge>}>
        <div className="flex flex-col gap-3">
          <Alert tone="warn" title={t('catalog_team.payments.simulation_title')}>{t('catalog_team.payments.simulation_body')}</Alert>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{t('fields.status')}:</span>
            {sandboxActive ? <Badge tone="ok"><CheckCircle2 className="size-3" aria-hidden />{t('catalog_team.payments.connected_test')}</Badge>
              : <Badge><CircleSlash className="size-3" aria-hidden />{sandbox ? t(`catalog_team.payments.status.${sandbox.status}`) : t('catalog_team.payments.not_connected')}</Badge>}
            {sandbox ? <span className="text-xs text-ink-muted">{t('catalog_team.payments.mode', { mode: sandbox.mode })} · {t('catalog_team.payments.methods', { methods: sandbox.enabled_methods.join(', ') })}</span> : null}
          </div>
          {canConfigure ? (
            <div className="flex flex-wrap gap-2">
              {!sandboxActive ? (
                <Button icon={<Plug className="size-4" />} loading={busy === 'connect'}
                  onClick={() => run('connect', () => api(`/api/v1/t/${slug}/payment-accounts`, { body: { provider: 'sandbox' } }), t('catalog_team.payments.connected_done'))}>{t('catalog_team.payments.connect_sandbox')}</Button>
              ) : (
                <Button variant="outline" icon={<Unplug className="size-4" />} onClick={() => setDisconnect(sandbox!)}>{t('catalog_team.payments.disconnect')}</Button>
              )}
              <p className="w-full text-xs text-ink-muted">{t('catalog_team.payments.stepup_note')}</p>
            </div>
          ) : <p className="text-xs text-ink-muted">{t('catalog_team.payments.view_only')}</p>}
        </div>
      </Card>

      <Card title={t('catalog_team.payments.providers_title')}>
        <p className="mb-3 text-sm text-ink-muted">{t('catalog_team.payments.providers_hint')}</p>
        <ul className="flex flex-col divide-y divide-line">
          {others.map((p) => (
            <li key={p.name} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:gap-3">
              <span className="font-medium sm:w-32">{t(`catalog_team.payments.provider.${p.name}`)}</span>
              <span className="flex-1 text-xs text-ink-muted">{locale === 'ar' ? p.note_ar : p.note_en}</span>
              <Badge>{t('catalog_team.payments.requires_credentials')}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t('catalog_team.payments.onsite_title')} actions={<Banknote className="size-5 text-luma-500" aria-hidden />}>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-ink-muted">{t('catalog_team.payments.onsite_hint')}</p>
          {policy ? (
            <ul className="flex flex-col gap-1">
              <li className="flex items-center gap-2"><Badge tone={policy.allow_pay_on_site ? 'ok' : 'neutral'}>{policy.allow_pay_on_site ? t('catalog_team.payments.on') : t('catalog_team.payments.off')}</Badge>{t('biz_settings.booking.allow_pay_on_site')}</li>
              <li className="flex items-center gap-2"><Badge tone={policy.allow_full_prepay ? 'ok' : 'neutral'}>{policy.allow_full_prepay ? t('catalog_team.payments.on') : t('catalog_team.payments.off')}</Badge>{t('biz_settings.booking.allow_full_prepay')}</li>
              <li className="flex items-center gap-2"><Badge tone={policy.deposit_mode !== 'none' ? 'ok' : 'neutral'}>{t(`biz_settings.booking.deposit.${policy.deposit_mode}`)}</Badge>{t('biz_settings.booking.deposit_mode')}</li>
            </ul>
          ) : null}
          <p className="text-xs text-ink-muted">{t('catalog_team.payments.onsite_methods')}</p>
          {access.can('business.manage') ? (
            <Link href={`/app/${slug}/settings?tab=booking`} className="self-start text-sm font-medium text-luma-700 underline underline-offset-2">{t('catalog_team.payments.edit_in_booking')}</Link>
          ) : null}
        </div>
      </Card>

      {canReconcile ? (
        <Card title={t('catalog_team.payments.reconcile_title')} actions={<Scale className="size-5 text-luma-500" aria-hidden />}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">{t('catalog_team.payments.reconcile_hint')}</p>
            <Button variant="outline" className="self-start" icon={<RefreshCw className="size-4" />} loading={busy === 'reconcile'} onClick={reconcile}>{t('catalog_team.payments.run_reconcile')}</Button>
            {recon ? (
              <Alert tone={recon.discrepancies.length ? 'warn' : 'ok'} title={recon.discrepancies.length ? t('catalog_team.payments.recon_issues', { n: recon.discrepancies.length }) : t('catalog_team.payments.recon_balanced')}>
                <p>{t('catalog_team.payments.recon_summary', { checked: recon.checked, repaired: recon.repaired })}</p>
                {recon.discrepancies.length ? (
                  <ul className="mt-1 list-disc ps-5 text-xs">
                    {recon.discrepancies.slice(0, 20).map((d, i) => <li key={`${d.payment_id}:${i}`}><span dir="ltr" className="font-mono">{d.payment_id.slice(0, 8)}</span> — {d.issue}</li>)}
                  </ul>
                ) : null}
              </Alert>
            ) : null}
          </div>
        </Card>
      ) : null}

      <ConfirmDialog open={!!disconnect} onClose={() => setDisconnect(null)} danger loading={busy === 'disconnect'} title={t('catalog_team.payments.disconnect_title')}
        body={t('catalog_team.payments.disconnect_body')} confirmLabel={t('catalog_team.payments.disconnect')}
        onConfirm={() => { const a = disconnect!; setDisconnect(null); run('disconnect', () => api(`/api/v1/t/${slug}/payment-accounts/${a.id}`, { method: 'DELETE' }), t('catalog_team.payments.disconnected_done')); }} />
    </div>
  );
}
