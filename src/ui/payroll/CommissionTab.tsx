'use client';

import { useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Input, MoneyInput, Switch } from '../components/form';
import { Alert, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { parseNum, useFmt } from '../commerce/common';
import { percent } from './common';

type Tier = { threshold_minor: number; rate_bp: number };
type CategoryPolicy = { enabled: boolean; rate_bp: number; tiers: Tier[] };
type Policy = { tips_enabled: boolean; services: CategoryPolicy; products: CategoryPolicy };
type Category = 'services' | 'products';

const toBp = (s: string) => {
  const n = parseNum(s);
  return n == null || n < 0 || n > 100 ? null : Math.round(n * 100);
};

/**
 * The business decides commission per category: services and products, each
 * switched on or off with one rate and optional monthly sales tiers.
 */
export function CommissionTab() {
  const { t } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const canManage = access.can('payroll.manage') && !access.readOnly;
  const q = useApiQuery<Policy>(['payroll-commission', access.slug], access.api('/payroll/commission-policy'));
  const tips = useApiMutation((v: boolean) => api(access.api('/payroll/commission-policy'), { method: 'PATCH', body: { tips_enabled: v } }), {
    onSuccess: () => { q.refetch(); toast({ tone: 'ok', text: t('payroll.commission.saved') }); },
  });
  if (q.isLoading) return <LoadingState rows={4} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data;
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" title={t('payroll.commission.how_title')}>{t('payroll.commission.how_body')}</Alert>
      <div className="grid gap-4 xl:grid-cols-2">
        {(['services', 'products'] as const).map((c) => (
          <CategoryCard key={`${c}:${JSON.stringify(p[c])}`} category={c} policy={p[c]} canManage={canManage} onSaved={() => q.refetch()} />
        ))}
      </div>
      <Card title={t('payroll.commission.tips_title')}>
        <Switch label={<span className="font-medium">{t('payroll.commission.tips')}</span>} checked={p.tips_enabled} disabled={!canManage || tips.isPending} onChange={(v) => tips.mutate(v)} />
        <p className="ms-11 mt-1 text-xs text-ink-muted">{t('payroll.commission.tips_hint')}</p>
        {tips.error ? <p className="mt-2 text-sm text-danger">{msg(tips.error)}</p> : null}
      </Card>
    </div>
  );
}

function CategoryCard({ category, policy, canManage, onSaved }: { category: Category; policy: CategoryPolicy; canManage: boolean; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const { money } = useFmt();
  const [enabled, setEnabled] = useState(policy.enabled);
  const [rate, setRate] = useState(percent(policy.rate_bp));
  const [tiers, setTiers] = useState(policy.tiers.map((x) => ({ threshold: x.threshold_minor as number | null, rate: percent(x.rate_bp) })));
  const rateBp = toBp(rate);
  const tierBps = tiers.map((x) => toBp(x.rate));
  const thresholds = tiers.map((x) => x.threshold);
  const tiersValid = tiers.every((x, i) => (x.threshold ?? 0) > 0 && tierBps[i] != null && (i === 0 || (x.threshold ?? 0) > (thresholds[i - 1] ?? 0)));
  const valid = rateBp != null && tiersValid;
  const body = { enabled, rate_bp: rateBp ?? 0, tiers: tiers.map((x, i) => ({ threshold_minor: x.threshold ?? 0, rate_bp: tierBps[i] ?? 0 })) };
  const dirty = JSON.stringify(body) !== JSON.stringify({ enabled: policy.enabled, rate_bp: policy.rate_bp, tiers: policy.tiers });
  const save = useApiMutation(() => api(access.api('/payroll/commission-policy'), { method: 'PATCH', body: { [category]: body } }), {
    onSuccess: () => { onSaved(); toast({ tone: 'ok', text: t('payroll.commission.saved') }); },
  });
  const lock = !canManage;
  const off = !enabled;
  // A worked example: the first tier's threshold (or 10,000) in sales.
  const sample = tiers[0]?.threshold ?? 1000000;
  const sampleRate = !enabled ? 0 : tiers.reduce((r, x, i) => ((x.threshold ?? Infinity) <= sample && tierBps[i] != null ? tierBps[i]! : r), rateBp ?? 0);

  return (
    <Card title={t(`payroll.commission.${category}_title`)}>
      <div className="flex flex-col gap-4">
        <div>
          <Switch label={<span className="font-medium">{t(`payroll.commission.${category}_enable`)}</span>} checked={enabled} disabled={lock} onChange={setEnabled} />
          <p className="ms-11 mt-1 text-xs text-ink-muted">{enabled ? t(`payroll.commission.${category}_on_hint`) : t(`payroll.commission.${category}_off_hint`)}</p>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('payroll.commission.rate')}</span>
          <span className="flex items-center gap-1">
            <span className="w-28 shrink-0"><Input dir="ltr" inputMode="decimal" value={rate} disabled={lock || off} onChange={(e) => setRate(e.target.value)} aria-invalid={rateBp == null} /></span>
            <span className="text-ink-muted">%</span>
          </span>
        </label>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('payroll.commission.tiers')}</p>
          <p className="text-xs text-ink-muted">{t('payroll.commission.tiers_hint')}</p>
          {tiers.map((x, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-muted">{t('payroll.commission.tier_from')}</span>
              <span className="w-36 shrink-0"><MoneyInput aria-label={t('payroll.commission.tier_threshold', { n: i + 1 })} value={x.threshold} disabled={lock || off}
                onChange={(v) => setTiers(tiers.map((y, j) => (j === i ? { ...y, threshold: v } : y)))} /></span>
              <span className="text-ink-muted">{t('payroll.commission.tier_rate')}</span>
              <span className="w-24 shrink-0"><Input dir="ltr" inputMode="decimal" aria-label={t('payroll.commission.tier_rate_n', { n: i + 1 })} value={x.rate} disabled={lock || off}
                onChange={(e) => setTiers(tiers.map((y, j) => (j === i ? { ...y, rate: e.target.value } : y)))} aria-invalid={tierBps[i] == null} /></span>
              <span className="text-ink-muted">%</span>
              {!lock ? <IconButton label={t('payroll.commission.remove_tier')} onClick={() => setTiers(tiers.filter((_, j) => j !== i))} disabled={off}><Trash2 className="size-4" aria-hidden /></IconButton> : null}
            </div>
          ))}
          {!lock && tiers.length < 10 ? (
            <div><Button size="sm" variant="ghost" icon={<Plus className="size-4" />} disabled={off}
              onClick={() => setTiers([...tiers, { threshold: null, rate: rate }])}>{t('payroll.commission.add_tier')}</Button></div>
          ) : null}
          {!tiersValid ? <p className="text-xs text-danger">{t('payroll.commission.tiers_invalid')}</p> : null}
        </div>
        {enabled && valid ? (
          <p className="rounded-lg bg-luma-50 px-3 py-2 text-xs text-ink-muted">
            {t('payroll.commission.example', { sales: money(sample), pct: percent(sampleRate), amount: money(Math.round((sample * sampleRate) / 10000)) })}
          </p>
        ) : null}
        {canManage ? (
          <div className="flex items-center gap-3">
            <Button icon={<Save className="size-4" />} disabled={!dirty || !valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('actions.save')}</Button>
            {save.error ? <p className="text-sm text-danger">{msg(save.error)}</p> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
