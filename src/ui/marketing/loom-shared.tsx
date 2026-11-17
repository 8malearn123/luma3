'use client';

import { useCallback, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatMoney } from '@/shared/format';
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

/**
 * Formats a Loom value by its metric unit (LUMA-AUDIT-023): money from minor
 * units in the business currency, ratios as percentages, minutes/days/ratings
 * with their unit. Unknown units fall back to a plain localized number.
 */
export function useLoomFmt() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const num = (v: number) => new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', { maximumFractionDigits: 1 }).format(v);
  return useCallback((unit: string | null | undefined, v: number | null | undefined): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    switch (unit) {
      case 'minor': return formatMoney(v, access.currency, locale);
      case 'ratio': return `${num(Math.round(v * 1000) / 10)}%`;
      case 'minutes': return t('loomux.units.minutes', { n: num(Math.round(v)) });
      case 'days': return t('loomux.units.days', { n: num(Math.round(v * 10) / 10) });
      case 'rating': return t('loomux.units.rating', { n: num(Math.round(v * 10) / 10) });
      default: return num(Math.round(v * 10) / 10);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale, access.currency]);
}

/** Readable channel name (falls back to the stored value for unknown channels). */
export function useChannelLabel() {
  const { t } = useI18n();
  return useCallback((c: string | null | undefined) => {
    if (!c) return '—';
    const k = `loomux.channel.${c}`;
    const v = t(k);
    return v === k ? c : v;
  }, [t]);
}
