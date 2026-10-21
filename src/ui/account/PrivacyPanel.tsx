'use client';

import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { FormErrorSummary, Switch } from '../components/form';
import { Card } from '../components/layout';

type Rel = { tenant_customer_id: string; tenant_name: string; consents: Record<string, Record<string, { granted: boolean; recorded_at: string | null }>> };

export function PrivacyPanel() {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const q = useApiQuery<Rel[]>(['account-consents'], '/api/v1/account/consents');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  async function set(rel: string, channel: string, purpose: string, granted: boolean) {
    const key = `${rel}:${channel}:${purpose}`;
    setBusy(key); setErr(null);
    try {
      await api('/api/v1/account/consents', { method: 'PUT', body: { tenant_customer_id: rel, channel, purpose, granted } });
      await qc.invalidateQueries({ queryKey: ['account-consents'] });
    } catch (e) { setErr(e); } finally { setBusy(null); }
  }
  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">{t('account.privacy.hint')}</p>
      <FormErrorSummary message={err ? msg(err) : null} />
      {!q.data?.length ? <EmptyState icon={<ShieldCheck className="size-8" aria-hidden />} title={t('account.privacy.empty')} /> : q.data.map((r) => (
        <Card key={r.tenant_customer_id} title={r.tenant_name}>
          <div className="grid gap-4 sm:grid-cols-2">
            {(['marketing', 'reminders'] as const).map((purpose) => (
              <fieldset key={purpose} className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">{t(`consents.purposes.${purpose}`)}</legend>
                {(['email', 'sms', 'whatsapp'] as const).map((ch) => {
                  const c = r.consents?.[purpose]?.[ch];
                  return <Switch key={ch} label={t(`consents.channels.${ch}`)} checked={!!c?.granted} disabled={busy === `${r.tenant_customer_id}:${ch}:${purpose}`} onChange={(v) => set(r.tenant_customer_id, ch, purpose, v)} />;
                })}
              </fieldset>
            ))}
          </div>
        </Card>
      ))}
      <p className="text-xs text-ink-muted">{t('consents.history_note')}</p>
    </div>
  );
}
