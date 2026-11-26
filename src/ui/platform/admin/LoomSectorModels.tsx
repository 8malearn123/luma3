'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/shared/format';
import { api } from '../../api';
import { useApiQuery, useErrorMessage } from '../../hooks';
import { Button } from '../../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Card } from '../../components/layout';
import { useToast } from '../../components/toast';
import { useStepUp } from '../stepup';

/** /platform/loom — sector models (phase 6): trained only on aggregates of businesses with shared-training consent. */
export function LoomSectorModels() {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useApiQuery<any>(['platform', 'loom', 'models'], '/api/v1/platform/loom/models');
  const run = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    try {
      await stepUp(() => api('/api/v1/platform/loom/models', { method: 'POST', body }));
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform', 'loom', 'models'] });
    } catch (e) { toast({ tone: 'danger', text: msg(e) }); } finally { setBusy(null); }
  };
  if (q.isLoading) return <LoadingState rows={2} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const total = d.business_versions.reduce((s: number, b: { n: number }) => s + b.n, 0);
  return (
    <Card title={t('loom_models.admin.sector_title')} actions={<Button size="sm" variant="outline" loading={busy === 'train'} onClick={() => run('train', { action: 'train_sector', sector: 'beauty' })}>{t('loom_models.admin.train_sector')}</Button>}>
      <p className="mb-2 text-xs text-ink-muted">{t('loom_models.admin.sector_explain')}</p>
      <p className="mb-2 text-xs">{t('loom_models.admin.business_versions', { n: total })}</p>
      {!d.versions.length ? <EmptyState title={t('loom_models.admin.sector_empty')} /> : (
        <ul className="flex flex-col gap-2 text-sm">
          {d.versions.map((v: any) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-2">
              <span>{v.sector} · {t(`loom_models.kind.${v.model_kind}`)} · {t('loom_models.version', { v: v.version })} <span className="text-xs text-ink-muted">{t('loom_models.admin.contributors', { n: v.metrics.contributors ?? 0 })}</span></span>
              <span className="text-xs text-ink-muted">{formatDateTime(v.created_at, { locale })}</span>
              <Badge tone={v.status === 'active' ? 'ok' : v.status === 'shadow' ? 'warn' : 'neutral'}>{t(`loom_models.status.${v.status}`)}</Badge>
              {v.status === 'shadow' ? <Button size="sm" loading={busy === v.id} onClick={() => run(v.id, { action: 'promote', version_id: v.id })}>{t('loom_models.actions.promote')}</Button> : null}
              {v.status === 'active' ? <Button size="sm" variant="outline" loading={busy === `rb${v.id}`} onClick={() => run(`rb${v.id}`, { action: 'rollback', sector: v.sector, model_kind: v.model_kind })}>{t('loom_models.actions.rollback')}</Button> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
