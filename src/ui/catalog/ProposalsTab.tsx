'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Tag, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery } from '../hooks';
import { Button } from '../components/button';
import { Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { ConfirmDialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { ApiErrorBox } from './common';

type Proposal = { id: string; service_id: string; name_ar: string | null; name_en: string | null; current_price_minor: number; proposed_price_minor: number; reason: string | null; source: string; status: string; created_at: string };

/** Price proposals: only the owner decides; confirmed bookings keep their snapshot price. */
export function ProposalsTab() {
  const { t, pick, locale } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const { money, when } = useFmt();
  const [status, setStatus] = useState<'proposed' | 'approved' | 'rejected'>('proposed');
  const q = useApiQuery<Proposal[]>(['price-proposals', access.slug, status], access.api(`/price-proposals?status=${status}`));
  const canDecide = access.role === 'owner' && !access.readOnly;
  const [decide, setDecide] = useState<{ p: Proposal; decision: 'approved' | 'rejected' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const Arrow = locale === 'ar' ? ArrowLeft : ArrowRight;

  async function confirm() {
    if (!decide) return;
    setBusy(true); setErr(null);
    try {
      await api(access.api(`/price-proposals/${decide.p.id}`), { body: { decision: decide.decision } });
      toast({ tone: 'ok', text: decide.decision === 'approved' ? t('catalog_team.proposals.approved_done') : t('catalog_team.proposals.rejected_done') });
      setDecide(null);
      await qc.invalidateQueries({ queryKey: ['price-proposals', access.slug] });
      await qc.invalidateQueries({ queryKey: ['services', access.slug] });
    } catch (e) { setErr(e); setDecide(null); await qc.invalidateQueries({ queryKey: ['price-proposals', access.slug] }); } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-muted">{canDecide ? t('catalog_team.proposals.hint_owner') : t('catalog_team.proposals.hint_other')}</p>
        <Select aria-label={t('fields.status')} className="sm:w-48" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="proposed">{t('catalog_team.proposals.status.proposed')}</option>
          <option value="approved">{t('catalog_team.proposals.status.approved')}</option>
          <option value="rejected">{t('catalog_team.proposals.status.rejected')}</option>
        </Select>
      </div>
      <ApiErrorBox err={err} />
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={<Tag className="size-8" aria-hidden />} title={status === 'proposed' ? t('catalog_team.proposals.empty') : t('states.empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {q.data.map((p) => {
            const up = p.proposed_price_minor > p.current_price_minor;
            return (
              <li key={p.id} className="flex flex-col gap-3 rounded-xl border border-line bg-white p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{pick(p.name_ar, p.name_en)}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                    <span dir="ltr" className="text-ink-muted line-through">{money(p.current_price_minor)}</span>
                    <Arrow className="size-4 text-ink-muted" aria-hidden />
                    <span dir="ltr" className="font-semibold">{money(p.proposed_price_minor)}</span>
                    <Badge tone={up ? 'warn' : 'info'}>{up ? t('catalog_team.proposals.increase') : t('catalog_team.proposals.decrease')}</Badge>
                    {p.source === 'recommendation' ? <Badge tone="brand">{t('catalog_team.proposals.from_recommendation')}</Badge> : null}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">{when(p.created_at)}{p.reason ? ` · ${p.reason}` : ''}</p>
                </div>
                {status === 'proposed' && canDecide ? (
                  <div className="flex gap-2">
                    <Button size="sm" icon={<Check className="size-4" />} onClick={() => setDecide({ p, decision: 'approved' })}>{t('catalog_ui.approve')}</Button>
                    <Button size="sm" variant="outline" icon={<X className="size-4" />} onClick={() => setDecide({ p, decision: 'rejected' })}>{t('catalog_ui.reject')}</Button>
                  </div>
                ) : status !== 'proposed' ? <Badge tone={p.status === 'approved' ? 'ok' : 'neutral'}>{t(`catalog_team.proposals.status.${p.status}`)}</Badge> : null}
              </li>
            );
          })}
        </ul>
      )}
      {status === 'proposed' && !canDecide && q.data?.length ? <Alert tone="info">{t('catalog_team.proposals.owner_only')}</Alert> : null}
      <ConfirmDialog open={!!decide} onClose={() => setDecide(null)} onConfirm={confirm} loading={busy} danger={decide?.decision === 'rejected'}
        title={decide?.decision === 'approved' ? t('catalog_team.proposals.approve_title') : t('catalog_team.proposals.reject_title')}
        body={decide ? t(decide.decision === 'approved' ? 'catalog_team.proposals.approve_body' : 'catalog_team.proposals.reject_body', { service: pick(decide.p.name_ar, decide.p.name_en), price: money(decide.p.proposed_price_minor) }) : null}
        confirmLabel={decide?.decision === 'approved' ? t('catalog_ui.approve') : t('catalog_ui.reject')} />
    </div>
  );
}
