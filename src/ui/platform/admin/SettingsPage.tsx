'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { api } from '../../api';
import { useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../../hooks';
import { Button } from '../../components/button';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Field, FormErrorSummary, Input, MoneyInput, Switch, Textarea } from '../../components/form';
import { Card, DataTable, PageHeader } from '../../components/layout';
import { useToast } from '../../components/toast';
import { When } from '../common';
import { usePlatform } from '../PlatformShell';
import { useStepUp } from '../stepup';
import type { PlatformSettings } from '@/shared/platform-settings';

export function PlatformSettingsPage() {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useApiQuery<{ settings: PlatformSettings }>(['platform', 'settings'], '/api/v1/platform/settings');
  const [f, setF] = useState<PlatformSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useUnsavedChangesWarning(dirty);
  // Initialise the form from the loaded settings once.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (q.data && !f) setF(q.data.settings); }, [q.data, f]);
  if (q.isLoading || (!f && !q.error)) return <LoadingState rows={6} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = f!;
  const set = (p: Partial<PlatformSettings>) => { setF({ ...s, ...p }); setDirty(true); };
  const original = q.data!.settings;

  async function save() {
    setBusy(true); setErr(null);
    const patch = Object.fromEntries(Object.entries(s).filter(([k, v]) => original[k as keyof PlatformSettings] !== v));
    try {
      if (Object.keys(patch).length) await stepUp(() => api('/api/v1/platform/settings', { method: 'PUT', body: patch }));
      setDirty(false);
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform', 'settings'] });
      setF(null);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('admin.settings.title')} subtitle={t('admin.settings.subtitle')} actions={<Button loading={busy} disabled={!dirty} onClick={save}>{t('actions.save')}</Button>} />
      <FormErrorSummary message={err ? msg(err) : null} issues={(err as any)?.details?.issues} />
      <Card title={t('admin.settings.platform_name')}>
        <Field label={t('admin.settings.platform_name')}>{(p) => <Input {...p} value={s.platform_name} onChange={(e) => set({ platform_name: e.target.value })} />}</Field>
      </Card>
      <Card title={t('admin.settings.maintenance_mode')}>
        <div className="flex flex-col gap-3">
          {s.maintenance_mode ? <Alert tone="warn">{t('admin.settings.maintenance_hint')}</Alert> : <p className="text-sm text-ink-muted">{t('admin.settings.maintenance_hint')}</p>}
          <Switch label={t('admin.settings.maintenance_mode')} checked={s.maintenance_mode} onChange={(v) => set({ maintenance_mode: v })} />
          <Field label={t('admin.settings.maintenance_message_ar')}>{(p) => <Textarea {...p} dir="rtl" value={s.maintenance_message_ar} onChange={(e) => set({ maintenance_message_ar: e.target.value })} />}</Field>
          <Field label={t('admin.settings.maintenance_message_en')}>{(p) => <Textarea {...p} dir="ltr" value={s.maintenance_message_en} onChange={(e) => set({ maintenance_message_en: e.target.value })} />}</Field>
        </div>
      </Card>
      <Card title={t('admin.settings.allow_signups')}>
        <div className="flex flex-col gap-3">
          <Switch label={t('admin.settings.allow_signups')} checked={s.allow_signups} onChange={(v) => set({ allow_signups: v })} />
          <Switch label={t('admin.settings.require_business_approval')} checked={s.require_business_approval} onChange={(v) => set({ require_business_approval: v })} />
          <Switch label={t('admin.settings.marketplace_requires_verification')} checked={s.marketplace_requires_verification} onChange={(v) => set({ marketplace_requires_verification: v })} />
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('admin.settings.founding')}>
          <div className="flex flex-col gap-3">
            <Switch label={t('admin.settings.founding_enabled')} checked={s.founding_enabled} onChange={(v) => set({ founding_enabled: v })} />
            <Field label={t('admin.settings.founding_seats_total')}>{(p) => <Input {...p} type="number" min={0} value={s.founding_seats_total} onChange={(e) => set({ founding_seats_total: Math.max(0, Math.round(Number(e.target.value))) })} />}</Field>
            <Field label={t('admin.settings.founding_discount')}>{(p) => <Input {...p} type="number" min={0} max={100} value={s.founding_discount_bp / 100} onChange={(e) => set({ founding_discount_bp: Math.round(Number(e.target.value) * 100) })} />}</Field>
          </div>
        </Card>
        <Card title={t('admin.settings.referrals')}>
          <div className="flex flex-col gap-3">
            <Field label={t('admin.settings.referral_rate')}>{(p) => <Input {...p} type="number" min={0} max={100} step="0.5" value={s.referral_default_rate_bp / 100} onChange={(e) => set({ referral_default_rate_bp: Math.round(Number(e.target.value) * 100) })} />}</Field>
            <Field label={t('admin.settings.referral_min')}>{(p) => <MoneyInput {...p} value={s.referral_min_withdrawal_minor} onChange={(v) => set({ referral_min_withdrawal_minor: v ?? 0 })} />}</Field>
          </div>
        </Card>
      </div>
      <ApprovalsCard />
    </div>
  );
}

type Approval = { tenant_id: string; slug: string; name: string; business_type: string; city: string | null; owner_name: string | null; created_at: string };

function ApprovalsCard() {
  const { t } = useI18n();
  const { can } = usePlatform();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useApiQuery<{ items: Approval[] }>(['platform', 'approvals'], '/api/v1/platform/approvals');
  const [err, setErr] = useState<unknown>(null);
  async function decide(a: Approval, decision: 'approve' | 'reject') {
    setErr(null);
    const reason = decision === 'reject' ? window.prompt(t('admin.referrals.reject_reason')) ?? '' : undefined;
    if (decision === 'reject' && !reason) return;
    try {
      await stepUp(() => api(`/api/v1/platform/approvals/${a.tenant_id}`, { body: { decision, ...(reason ? { reason } : {}) } }));
      await qc.invalidateQueries({ queryKey: ['platform', 'approvals'] });
    } catch (e) { setErr(e); }
  }
  return (
    <Card title={t('admin.settings.approvals')}>
      <FormErrorSummary message={err ? msg(err) : null} />
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} /> : !q.data!.items.length ? <EmptyState title={t('admin.settings.no_pending')} /> : (
        <DataTable rows={q.data!.items} rowKey={(a) => a.tenant_id} caption={t('admin.settings.approvals')} columns={[
          { key: 'n', header: t('admin.tenant'), cell: (a) => <span>{a.name} <span className="text-xs text-ink-muted" dir="ltr">/{a.slug}</span></span> },
          { key: 'o', header: t('admin.settings.owner'), className: 'hidden sm:table-cell', cell: (a) => a.owner_name ?? '—' },
          { key: 'c', header: t('admin.analytics.city'), className: 'hidden md:table-cell', cell: (a) => a.city ?? '—' },
          { key: 'd', header: t('admin.activity.created'), className: 'hidden md:table-cell', cell: (a) => <When v={a.created_at} /> },
          { key: 'x', header: '', cell: (a) => can('platform.tenants.manage') ? (
            <div className="flex gap-1"><Button size="sm" onClick={() => decide(a, 'approve')}>{t('admin.settings.approve')}</Button><Button size="sm" variant="ghost" onClick={() => decide(a, 'reject')}>{t('admin.settings.reject')}</Button></div>
          ) : null },
        ]} />
      )}
    </Card>
  );
}
