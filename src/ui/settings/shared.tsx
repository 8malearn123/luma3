'use client';

import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Alert } from '../components/feedback';
import { FormErrorSummary } from '../components/form';
import { useToast } from '../components/toast';

export type SettingsData = {
  tenant: { id: string; slug: string; name: string; city: string | null; default_locale: 'ar' | 'en'; timezone: string; currency: string; status: string; business_type: string };
  settings: Record<string, any> & { version: number; social_links: Record<string, string>; notify_channels: string[]; booking_policy_confirmed_at: string | null };
  channel_status: Record<'in_app' | 'email' | 'sms' | 'whatsapp', 'connected' | 'dev_simulation' | 'disconnected'>;
};

export const settingsKey = (slug: string) => ['settings', slug];

/**
 * Form state for one settings section. All sections share tenant_settings.version:
 * a stale version returns 409 and the user is offered a reload instead of an overwrite.
 */
export function useSection<T extends Record<string, any>>(slug: string, data: SettingsData, pickValues: (d: SettingsData) => T) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [values, setValues] = useState<T>(() => pickValues(data));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useUnsavedChangesWarning(dirty);
  // After a save/reload the query returns fresh data: adopt it unless the user is mid-edit.
  const [seen, setSeen] = useState(data);
  if (seen !== data) {
    setSeen(data);
    if (!dirty) setValues(pickValues(data));
  }
  const set = (p: Partial<T>) => { setValues((v) => ({ ...v, ...p })); setDirty(true); };
  async function save(path: string, body: Record<string, unknown>, method: 'PUT' | 'POST' = 'PUT') {
    setBusy(true); setErr(null);
    try {
      const r = await api(`/api/v1/t/${slug}/settings/${path}`, { method, body: { version: data.settings.version, ...body } });
      setDirty(false);
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: settingsKey(slug) });
      await qc.invalidateQueries({ queryKey: ['readiness', slug] });
      return r;
    } catch (e) { setErr(e); return null; } finally { setBusy(false); }
  }
  const reload = async () => { setDirty(false); setErr(null); await qc.invalidateQueries({ queryKey: settingsKey(slug) }); };
  return { values, set, dirty, busy, err, save, reload };
}

export function SectionErrors({ err, onReload }: { err: unknown; onReload: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  if (!err) return null;
  if (err instanceof ApiError && err.code === 'version_conflict') {
    return (
      <Alert tone="warn" title={t('errors.version_conflict')}>
        <Button size="sm" variant="outline" className="mt-2" icon={<RefreshCw className="size-4" />} onClick={onReload}>{t('actions.reload')}</Button>
      </Alert>
    );
  }
  const issues = err instanceof ApiError ? (err.details?.issues as Array<{ path: string; message: string }> | undefined) : undefined;
  return <FormErrorSummary message={msg(err)} issues={issues} />;
}

export function SaveBar({ dirty, busy, onSave, extra }: { dirty: boolean; busy: boolean; onSave: () => void; extra?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
      <Button loading={busy} disabled={!dirty} onClick={onSave}>{t('actions.save')}</Button>
      {dirty ? <span className="text-xs text-warn">{t('states.unsaved')}</span> : null}
      {extra}
    </div>
  );
}

export function ChannelBadge({ state }: { state: string }) {
  const { t } = useI18n();
  const cls = state === 'connected' ? 'bg-ok-bg text-ok' : state === 'dev_simulation' ? 'bg-info-bg text-info' : 'bg-warn-bg text-warn';
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{t(`platform.integration_state.${state}`)}</span>;
}

/** Number input that keeps an integer (empty → 0). */
export function intOf(v: string) {
  const n = Number(v.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))));
  return Number.isFinite(n) ? Math.round(n) : 0;
}
