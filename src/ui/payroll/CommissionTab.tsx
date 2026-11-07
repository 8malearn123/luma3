'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Save, Sparkles } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Input, Switch } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { parseNum, useFmt } from '../commerce/common';
import { percent } from './common';

type Rule = { id: string; kind: string; rate_bp: number | null; amount_minor: number | null } | null;
type ServiceRow = { id: string; name_ar: string | null; name_en: string | null; price_minor: number; is_active: boolean; commission_enabled: boolean; rule: Rule; staff_overrides: number };
type Policy = {
  service_commission_enabled: boolean; tips_enabled: boolean; products_earn_commission: false;
  default_rule: Rule; staff_rules: number; services: ServiceRow[];
};

const toBp = (s: string) => {
  const n = parseNum(s);
  return n == null ? null : Math.round(n * 100);
};
const validPct = (s: string) => {
  if (s.trim() === '') return true;
  const n = parseNum(s);
  return n != null && n >= 0 && n <= 100;
};

/** The business decides: service commission on or off, a default rate, and a switch + percentage per service. Products never earn commission. */
export function CommissionTab() {
  const { t } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const canManage = access.can('payroll.manage') && !access.readOnly;
  const q = useApiQuery<Policy>(['payroll-commission', access.slug], access.api('/payroll/commission-policy'));
  const patch = useApiMutation((body: Record<string, unknown>) => api(access.api('/payroll/commission-policy'), { method: 'PATCH', body }), {
    onSuccess: () => { q.refetch(); toast({ tone: 'ok', text: t('payroll.commission.saved') }); },
  });
  const [defaultPct, setDefaultPct] = useState<string | null>(null);
  const p = q.data;
  if (q.isLoading) return <LoadingState rows={4} />;
  if (q.error || !p) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const defaultValue = defaultPct ?? (p.default_rule?.kind === 'percent' ? percent(p.default_rule.rate_bp) : '');
  const defaultDirty = defaultPct != null && toBp(defaultPct) !== (p.default_rule?.kind === 'percent' ? p.default_rule.rate_bp : null);

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" title={t('payroll.commission.products_title')}>{t('payroll.commission.products_body')}</Alert>
      <Card title={t('payroll.commission.policy')}>
        <div className="flex flex-col gap-4">
          <div>
            <Switch label={<span className="font-medium">{t('payroll.commission.enable')}</span>} checked={p.service_commission_enabled} disabled={!canManage || patch.isPending}
              onChange={(v) => patch.mutate({ service_commission_enabled: v })} />
            <p className="ms-11 mt-1 text-xs text-ink-muted">{p.service_commission_enabled ? t('payroll.commission.enabled_hint') : t('payroll.commission.disabled_hint')}</p>
          </div>
          <div>
            <Switch label={<span className="font-medium">{t('payroll.commission.tips')}</span>} checked={p.tips_enabled} disabled={!canManage || patch.isPending}
              onChange={(v) => patch.mutate({ tips_enabled: v })} />
            <p className="ms-11 mt-1 text-xs text-ink-muted">{t('payroll.commission.tips_hint')}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('payroll.commission.default_rate')}</span>
              <span className="flex items-center gap-1">
                <span className="w-28 shrink-0"><Input dir="ltr" inputMode="decimal" placeholder="—" value={defaultValue} disabled={!canManage || !p.service_commission_enabled}
                  onChange={(e) => setDefaultPct(e.target.value)} aria-invalid={!validPct(defaultValue)} /></span>
                <span className="text-ink-muted">%</span>
              </span>
            </label>
            {canManage ? <Button size="sm" variant="outline" icon={<Save className="size-4" />} disabled={!defaultDirty || !validPct(defaultValue)} loading={patch.isPending}
              onClick={() => patch.mutate({ default_rate_bp: toBp(defaultValue) }, { onSuccess: () => setDefaultPct(null) })}>{t('actions.save')}</Button> : null}
          </div>
          <p className="text-xs text-ink-muted">{t('payroll.commission.default_hint')}</p>
          {patch.error ? <p className="text-sm text-danger">{msg(patch.error)}</p> : null}
        </div>
      </Card>

      <Card title={t('payroll.commission.services')}>
        <p className="mb-3 text-xs text-ink-muted">{t('payroll.commission.services_hint')}</p>
        {!p.services.length ? <EmptyState icon={<Sparkles className="size-8" aria-hidden />} title={t('payroll.commission.no_services')} /> : (
          <ul className="flex flex-col divide-y divide-line">
            {p.services.map((s) => (
              <ServiceCommissionRow key={`${s.id}:${s.commission_enabled}:${s.rule?.id ?? ''}`} s={s} masterOn={p.service_commission_enabled} defaultRule={p.default_rule}
                canManage={canManage} onSaved={() => q.refetch()} />
            ))}
          </ul>
        )}
        {p.staff_rules ? (
          <p className="mt-3 text-xs text-ink-muted">
            {t('payroll.commission.staff_rules', { n: p.staff_rules })}{' '}
            {access.can('finance.view') ? <Link className="text-luma-700 hover:underline" href={`/app/${access.slug}/finance?tab=commissions`}>{t('payroll.commission.advanced_link')}</Link> : null}
          </p>
        ) : null}
      </Card>
    </div>
  );
}

function ServiceCommissionRow({ s, masterOn, defaultRule, canManage, onSaved }: { s: ServiceRow; masterOn: boolean; defaultRule: Rule; canManage: boolean; onSaved: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const msg = useErrorMessage();
  const { money } = useFmt();
  const initialPct = s.rule?.kind === 'percent' ? percent(s.rule.rate_bp) : '';
  const [enabled, setEnabled] = useState(s.commission_enabled);
  const [pct, setPct] = useState(initialPct);
  const dirty = enabled !== s.commission_enabled || pct !== initialPct;
  const save = useApiMutation(() => api(access.api(`/payroll/commission-policy/services/${s.id}`), { method: 'PUT', body: { commission_enabled: enabled, rate_bp: pct.trim() === '' ? null : toBp(pct) } }), {
    onSuccess: () => { onSaved(); toast({ tone: 'ok', text: t('payroll.commission.service_saved', { name: pick(s.name_ar, s.name_en) }) }); },
  });
  const fallback = defaultRule?.kind === 'percent' ? t('payroll.commission.uses_default', { pct: percent(defaultRule.rate_bp) }) : t('payroll.commission.no_rate');
  const live = masterOn && enabled;
  const rateBp = pct.trim() === '' ? (defaultRule?.kind === 'percent' ? defaultRule.rate_bp : null) : toBp(pct);
  return (
    <li className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <p className="font-medium">{pick(s.name_ar, s.name_en)} {!s.is_active ? <Badge tone="neutral">{t('fields.inactive')}</Badge> : null}</p>
        <p className="text-xs text-ink-muted">
          <span dir="ltr">{money(s.price_minor)}</span>
          {live && rateBp != null ? <> · {t('payroll.commission.example', { amount: money(Math.round((s.price_minor * rateBp) / 10000)) })}</> : null}
          {s.rule?.kind === 'fixed' ? <> · {t('payroll.commission.fixed_rule', { amount: money(s.rule.amount_minor) })}</> : null}
          {s.staff_overrides ? <> · {t('payroll.commission.overrides', { n: s.staff_overrides })}</> : null}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Switch label={enabled ? t('payroll.commission.on') : t('payroll.commission.off')} checked={enabled} disabled={!canManage || !masterOn} onChange={setEnabled} />
        <span className="flex items-center gap-1">
          <span className="w-24 shrink-0"><Input dir="ltr" inputMode="decimal" aria-label={t('payroll.commission.rate_for', { name: pick(s.name_ar, s.name_en) })} placeholder={defaultRule?.kind === 'percent' ? percent(defaultRule.rate_bp) : '—'}
            value={pct} disabled={!canManage || !live} onChange={(e) => setPct(e.target.value)} aria-invalid={!validPct(pct)} /></span>
          <span className="text-ink-muted">%</span>
        </span>
        {pct.trim() === '' && live ? <span className="text-xs text-ink-muted">{fallback}</span> : null}
        {canManage ? <Button size="sm" variant="outline" icon={<Save className="size-4" />} disabled={!dirty || !validPct(pct) || !masterOn} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('actions.save')}</Button> : null}
      </div>
      {save.error ? <p className="text-sm text-danger">{msg(save.error)}</p> : null}
    </li>
  );
}
