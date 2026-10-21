'use client';

import { useState } from 'react';
import { FlaskConical, Plus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, FormErrorSummary, Input, Select, Switch } from '../components/form';
import { Card } from '../components/layout';
import { ActionBadge } from './labels';
import { useStepUp } from './StepUp';

type Rule = { id: string; key: string; description: string | null; criteria: { incident_type?: string; min_confirmed: number; window_days: number }; suggested_action: string; is_enabled: boolean; is_experimental: boolean; version: number };

/** Tenant criteria (inside the dashboard). */
export function RulesPanel() {
  const access = useAccess();
  return <RulesEditor endpoint={access.api('/policies/rules')} queryKey={['rules', access.slug]} writable={!access.readOnly} />;
}

/** Shared editor; the platform page passes its own endpoint. Rules only ever suggest. */
export function RulesEditor({ endpoint, queryKey, writable }: { endpoint: string; queryKey: string[]; writable: boolean }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useApiQuery<Rule[]>(queryKey, endpoint);
  const [form, setForm] = useState({ key: '', description: '', incident_type: '', min_confirmed: '', window_days: '', suggested_action: 'require_deposit', is_experimental: true });
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function call(path: string, method: string, body: unknown) {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api(path, { method, body }));
      await qc.invalidateQueries({ queryKey });
      return true;
    } catch (e) { if (!(e instanceof ApiError && e.message === 'cancelled')) setErr(e); return false; } finally { setBusy(false); }
  }
  async function create() {
    const ok = await call(endpoint, 'POST', {
      key: form.key, description: form.description || null, suggested_action: form.suggested_action, is_experimental: form.is_experimental,
      criteria: { ...(form.incident_type ? { incident_type: form.incident_type } : {}), min_confirmed: Number(form.min_confirmed), window_days: Number(form.window_days) },
    });
    if (ok) { setOpen(false); setForm({ ...form, key: '', description: '', min_confirmed: '', window_days: '' }); }
  }
  const issues = err instanceof ApiError && err.code === 'validation_failed' ? (err.details?.issues as Array<{ path: string; message: string }>) : undefined;
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="warn" title={t('policy.decisions.experimental')}>{t('policy.rules.experimental_note')}</Alert>
      <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
      {writable ? <div><Button icon={<Plus className="size-4" />} onClick={() => setOpen((o) => !o)}>{t('policy.rules.new')}</Button></div> : null}
      {open ? (
        <Card title={t('policy.rules.new')}>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <Field label={t('policy.rules.key')} required hint="a-z 0-9 . _ -">{(p) => <Input {...p} dir="ltr" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase() })} />}</Field>
            <Field label={t('policy.rules.description')}>{(p) => <Input {...p} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
            <Field label={t('policy.rules.incident_type')}>{(p) => (
              <Select {...p} value={form.incident_type} onChange={(e) => setForm({ ...form, incident_type: e.target.value })}>
                <option value="">{t('policy.rules.any_type')}</option>
                {['no_show', 'late_cancellation', 'payment_dispute', 'conduct', 'other'].map((x) => <option key={x} value={x}>{t(`policy.types.${x}`)}</option>)}
              </Select>
            )}</Field>
            <Field label={t('policy.rules.suggested_action')}>{(p) => (
              <Select {...p} value={form.suggested_action} onChange={(e) => setForm({ ...form, suggested_action: e.target.value })}>
                {['require_deposit', 'require_full_payment', 'manual_approval'].map((x) => <option key={x} value={x}>{t(`policy.actions_labels.${x}`)}</option>)}
              </Select>
            )}</Field>
            <Field label={t('policy.rules.min_confirmed')} required>{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={form.min_confirmed} onChange={(e) => setForm({ ...form, min_confirmed: e.target.value.replace(/\D/g, '') })} />}</Field>
            <Field label={t('policy.rules.window_days')} required>{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={form.window_days} onChange={(e) => setForm({ ...form, window_days: e.target.value.replace(/\D/g, '') })} />}</Field>
            <div className="sm:col-span-2"><Checkbox label={t('policy.decisions.experimental')} description={t('policy.decisions.experimental_hint')} checked={form.is_experimental} onChange={(v) => setForm({ ...form, is_experimental: v })} /></div>
            <div className="sm:col-span-2"><Button type="submit" loading={busy} disabled={!form.key || !form.min_confirmed || !form.window_days}>{t('actions.create')}</Button></div>
          </form>
        </Card>
      ) : null}
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <EmptyState title={t('policy.rules.none')} icon={<FlaskConical className="size-8" aria-hidden />} /> : (
        <ul className="flex flex-col gap-2">
          {q.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white p-3">
              <div className="min-w-48 flex-1">
                <p className="font-medium" dir="ltr">{r.key}</p>
                <p className="text-sm text-ink-muted">{r.criteria.incident_type ? `${t(`policy.types.${r.criteria.incident_type}`)} · ` : ''}{t('policy.rules.summary', { min: r.criteria.min_confirmed, days: r.criteria.window_days })}</p>
                {r.description ? <p className="text-xs text-ink-muted">{r.description}</p> : null}
              </div>
              <ActionBadge action={r.suggested_action} />
              {r.is_experimental ? <Badge tone="warn">{t('policy.decisions.experimental')}</Badge> : null}
              <Switch label={t('policy.rules.enabled')} checked={r.is_enabled} disabled={!writable || busy} onChange={(v) => call(`${endpoint}/${r.id}`, 'PATCH', { version: r.version, is_enabled: v })} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
