'use client';

import { useCallback, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Badge } from '../components/feedback';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';

const PLAN_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand'> = {
  draft: 'neutral', proposed: 'info', under_review: 'info', approved: 'ok', in_progress: 'brand', completed: 'ok', deferred: 'warn', rejected: 'danger',
};
const JOB_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = {
  queued: 'neutral', running: 'info', succeeded: 'ok', failed: 'danger', insufficient_data: 'warn', unavailable: 'warn', cancelled: 'neutral',
};
const CAMPAIGN_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand'> = {
  draft: 'neutral', approved: 'info', scheduled: 'brand', sending: 'info', sent: 'ok', paused: 'warn', failed: 'danger', completed: 'ok', cancelled: 'neutral',
};

export function PlanStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={PLAN_TONE[status] ?? 'neutral'}>{t(`marketing.plan_status.${status}`)}</Badge>;
}
export function JobStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={JOB_TONE[status] ?? 'neutral'}>{t(`marketing.job_status.${status}`)}</Badge>;
}
export function CampaignStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={CAMPAIGN_TONE[status] ?? 'neutral'}>{t(`marketing.campaign_status.${status}`)}</Badge>;
}
export function SourceBadge({ source }: { source: string }) {
  const { t } = useI18n();
  return <Badge tone={source === 'ai' ? 'brand' : source === 'example' ? 'warn' : 'neutral'}>{t(`marketing.source.${source}`)}</Badge>;
}

/** POST/PUT/PATCH helper with toast feedback and cache invalidation. */
export function useAct() {
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const act = useCallback(async <T = any>(key: string, path: string, opts: { body?: unknown; method?: string; invalidate?: QueryKey[]; ok?: string } = {}): Promise<T | null> => {
    setBusy(key);
    try {
      const r = await api<T>(access.api(path), { method: opts.method ?? 'POST', body: opts.body ?? {} });
      for (const k of opts.invalidate ?? [['loom', access.slug]]) await qc.invalidateQueries({ queryKey: k });
      if (opts.ok) toast({ tone: 'ok', text: opts.ok });
      return r;
    } catch (e) {
      toast({ tone: 'danger', text: msg(e) });
      return null;
    } finally {
      setBusy(null);
    }
  }, [access, qc, toast, msg]);
  return { act, busy };
}

export const loomKey = (slug: string, ...rest: string[]) => ['loom', slug, ...rest];
