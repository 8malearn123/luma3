'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Store } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Badge, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input } from '../components/form';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';
import { KV, Money } from './common';
import { usePlatform } from './PlatformShell';
import { useStepUp } from './stepup';

const tone = (s: string | null) => (s === 'approved' || s === 'verified' ? 'ok' : s === 'pending' ? 'info' : s === 'rejected' ? 'danger' : 'neutral') as 'ok' | 'info' | 'danger' | 'neutral';

type Summary = { listing_status: string; hidden: boolean; verification_status: string; commission_bp: number | null; default_commission_bp: number; effective_bp: number; visible: boolean; fees_total: { bookings: number; fee_minor: number } };

/** Card in the platform business drawer: marketplace state and the per-business commission rate. */
export function TenantMarketplaceCard({ tenantId }: { tenantId: string }) {
  const { t } = useI18n();
  const { can } = usePlatform();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const msg = useErrorMessage();
  const q = useApiQuery<Summary>(['platform', 'market', 'tenant', tenantId], `/api/v1/platform/marketplace/tenants/${tenantId}`);
  const [pct, setPct] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const save = async (bp: number | null) => {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api(`/api/v1/platform/marketplace/tenants/${tenantId}/commission`, { method: 'PUT', body: { commission_bp: bp } }));
      setPct(null); toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform', 'market'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Store className="size-4 text-luma-700" aria-hidden />{t('market.name')}</span>}>
      {q.isLoading ? <LoadingState rows={2} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Badge tone={tone(q.data.listing_status)}>{t(`market.listing_status.${q.data.listing_status}`)}</Badge>
            <Badge tone={tone(q.data.verification_status)}>{t(`market.verification_status.${q.data.verification_status}`)}</Badge>
            {q.data.visible ? <Badge tone="ok">{t('market.admin.visible')}</Badge> : null}
            {q.data.hidden ? <Badge>{t('market.admin.hidden')}</Badge> : null}
          </div>
          <dl>
            <KV label={t('market.admin.commission')}>{q.data.effective_bp / 100}% {q.data.commission_bp == null ? <span className="text-xs text-ink-muted">({t('market.admin.default')})</span> : null}</KV>
            <KV label={t('market.admin.fees_to_date')}><Money minor={q.data.fees_total.fee_minor} /> · {t('market.admin.n_bookings', { n: q.data.fees_total.bookings })}</KV>
          </dl>
          <FormErrorSummary message={err ? msg(err) : null} />
          {can('platform.marketplace.manage') ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t('market.admin.set_commission')}>{(p) => (
                <div className="flex items-center gap-2"><Input {...p} type="number" min={0} max={100} step="0.01" dir="ltr" className="w-28"
                  value={pct ?? String(q.data!.effective_bp / 100)} onChange={(e) => setPct(e.target.value)} /><span className="text-sm text-ink-muted">%</span></div>
              )}</Field>
              <Button loading={busy} disabled={pct == null || !/^\d{1,3}(\.\d{1,2})?$/.test(pct) || Number(pct) > 100} onClick={() => save(Math.round(Number(pct) * 100))}>{t('actions.save')}</Button>
              {q.data.commission_bp != null ? <Button variant="ghost" disabled={busy} onClick={() => save(null)}>{t('market.admin.use_default')}</Button> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
