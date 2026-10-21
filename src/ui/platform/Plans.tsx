'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Minus, Pencil } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, FormErrorSummary, Input, MoneyInput, Select, Switch } from '../components/form';
import { Card, PageHeader } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { PLAN_FEATURES } from '@/shared/plans';
import { Money, TestBadge } from './common';
import { usePlatform } from './PlatformShell';
import { useStepUp } from './stepup';

type Feature = { feature_key: string; kind: 'limit' | 'switch'; enabled: boolean; limit_value: number | null };
type Plan = {
  id: string; code: string; name_ar: string; name_en: string; description_ar: string | null; description_en: string | null; price_monthly_minor: number | null; price_yearly_minor: number | null;
  price_is_test: boolean; currency: string; trial_days: number; grace_days: number; status: string; sort: number; version: number; features: Feature[]; subscriptions: Record<string, number>;
};

export function PlansPage() {
  const { t, pick, locale } = useI18n();
  const { can } = usePlatform();
  const q = useApiQuery<Plan[]>(['platform', 'plans'], '/api/v1/platform/plans');
  const [edit, setEdit] = useState<Plan | null>(null);
  if (q.isLoading) return <LoadingState rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const plans = q.data!;
  const keys = Object.keys(PLAN_FEATURES) as Array<keyof typeof PLAN_FEATURES>;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('platform.plans.title')} subtitle={t('platform.plans.subtitle')} />
      <Alert tone="warn">{t('platform.plans.not_final')}</Alert>
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => (
          <Card key={p.id} title={<span className="font-display text-xl text-luma-700">{pick(p.name_ar, p.name_en)}</span>}
            actions={can('platform.plans.manage') ? <Button size="sm" variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEdit(p)}>{t('actions.edit')}</Button> : null}>
            <p className="text-sm text-ink-muted">{pick(p.description_ar, p.description_en)}</p>
            <p className="mt-3 text-lg font-semibold"><Money minor={p.price_monthly_minor} currency={p.currency} />{p.price_monthly_minor != null ? <span className="text-sm font-normal"> / {t('platform.plans.month')}</span> : null}</p>
            {p.price_monthly_minor != null && p.price_is_test ? <TestBadge /> : null}
            <dl className="mt-3 grid grid-cols-2 gap-1 text-sm">
              <dt className="text-ink-muted">{t('platform.plans.trial_days')}</dt><dd>{p.trial_days}</dd>
              <dt className="text-ink-muted">{t('platform.plans.grace_days')}</dt><dd>{p.grace_days}</dd>
              <dt className="text-ink-muted">{t('fields.status')}</dt><dd><Badge tone={p.status === 'active' ? 'ok' : 'neutral'}>{t(`platform.plans.status.${p.status}`)}</Badge></dd>
              <dt className="text-ink-muted">{t('platform.plans.subscribers')}</dt><dd>{Object.entries(p.subscriptions).map(([s, n]) => `${t(`platform.sub_status.${s}`)}: ${n}`).join(' · ') || '0'}</dd>
            </dl>
          </Card>
        ))}
      </div>
      <Card title={t('platform.plans.matrix')}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('platform.plans.matrix')}</caption>
            <thead><tr className="text-xs text-ink-muted"><th scope="col" className="p-2 text-start">{t('platform.plans.feature')}</th>{plans.map((p) => <th key={p.id} scope="col" className="p-2 text-center">{pick(p.name_ar, p.name_en)}</th>)}</tr></thead>
            <tbody>{keys.map((k) => (
              <tr key={k} className="border-t border-line">
                <th scope="row" className="p-2 text-start font-normal">{locale === 'ar' ? PLAN_FEATURES[k].label_ar : PLAN_FEATURES[k].label_en}</th>
                {plans.map((p) => {
                  const f = p.features.find((x) => x.feature_key === k)!;
                  return <td key={p.id} className="p-2 text-center">{!f.enabled ? <Minus className="mx-auto size-4 text-ink-muted" aria-label={t('site.not_included')} /> : f.kind === 'limit' ? (f.limit_value ?? t('site.unlimited')) : <Check className="mx-auto size-4 text-ok" aria-label={t('site.included')} />}</td>;
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
      {edit ? <PlanEditor plan={edit} onClose={() => setEdit(null)} /> : null}
    </div>
  );
}

function PlanEditor({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [f, setF] = useState({ ...plan, features: plan.features.map((x) => ({ ...x })) });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useUnsavedChangesWarning(dirty);
  const set = (p: Partial<typeof f>) => { setF((x) => ({ ...x, ...p })); setDirty(true); };
  const setFeature = (k: string, p: Partial<Feature>) => set({ features: f.features.map((x) => (x.feature_key === k ? { ...x, ...p } : x)) });

  async function save() {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api(`/api/v1/platform/plans/${plan.id}`, { method: 'PUT', body: {
        version: plan.version, name_ar: f.name_ar, name_en: f.name_en, description_ar: f.description_ar, description_en: f.description_en,
        price_monthly_minor: f.price_monthly_minor, price_yearly_minor: f.price_yearly_minor, price_is_test: f.price_is_test,
        trial_days: Number(f.trial_days), grace_days: Number(f.grace_days), status: f.status,
        features: f.features.map((x) => ({ feature_key: x.feature_key, enabled: x.enabled, limit_value: x.kind === 'limit' ? x.limit_value : null })),
      } }));
      setDirty(false); toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform', 'plans'] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} wide title={`${t('actions.edit')}: ${locale === 'ar' ? plan.name_ar : plan.name_en}`}
      footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} onClick={save}>{t('actions.save')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={err ? msg(err) : null} issues={(err as any)?.details?.issues} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.name_ar')} required>{(p) => <Input {...p} dir="rtl" value={f.name_ar} onChange={(e) => set({ name_ar: e.target.value })} />}</Field>
          <Field label={t('fields.name_en')} required>{(p) => <Input {...p} dir="ltr" value={f.name_en} onChange={(e) => set({ name_en: e.target.value })} />}</Field>
          <Field label={t('platform.plans.price_monthly')} hint={t('platform.plans.price_hint')}>{(p) => <MoneyInput {...p} value={f.price_monthly_minor} onChange={(v) => set({ price_monthly_minor: v })} />}</Field>
          <Field label={t('platform.plans.price_yearly')} hint={t('platform.plans.price_hint')}>{(p) => <MoneyInput {...p} value={f.price_yearly_minor} onChange={(v) => set({ price_yearly_minor: v })} />}</Field>
          <Field label={t('platform.plans.trial_days')} hint={t('platform.plans.trial_hint')}>{(p) => <Input {...p} type="number" min={0} max={90} value={f.trial_days} onChange={(e) => set({ trial_days: Number(e.target.value) })} />}</Field>
          <Field label={t('platform.plans.grace_days')} hint={t('platform.plans.grace_hint')}>{(p) => <Input {...p} type="number" min={0} max={60} value={f.grace_days} onChange={(e) => set({ grace_days: Number(e.target.value) })} />}</Field>
          <Field label={t('fields.status')}>{(p) => <Select {...p} value={f.status} onChange={(e) => set({ status: e.target.value })}>{['draft', 'active', 'retired'].map((s) => <option key={s} value={s}>{t(`platform.plans.status.${s}`)}</option>)}</Select>}</Field>
          <div className="self-end pb-2"><Checkbox label={t('platform.plans.price_is_test')} description={t('platform.plans.price_is_test_hint')} checked={f.price_is_test} onChange={(v) => set({ price_is_test: v })} /></div>
        </div>
        <h3 className="font-semibold">{t('platform.plans.matrix')}</h3>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {f.features.map((x) => {
            const meta = PLAN_FEATURES[x.feature_key as keyof typeof PLAN_FEATURES];
            return (
              <li key={x.feature_key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <Switch label={locale === 'ar' ? meta.label_ar : meta.label_en} checked={x.enabled} onChange={(v) => setFeature(x.feature_key, { enabled: v })} />
                {x.kind === 'limit' && x.enabled ? (
                  <div className="flex items-center gap-2">
                    <Checkbox label={t('site.unlimited')} checked={x.limit_value === null} onChange={(v) => setFeature(x.feature_key, { limit_value: v ? null : 1 })} />
                    {x.limit_value !== null ? <Input aria-label={`${meta.label_en} limit`} type="number" min={0} className="w-24" value={x.limit_value} onChange={(e) => setFeature(x.feature_key, { limit_value: Math.max(0, Number(e.target.value)) })} /> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-ink-muted">{t('platform.plans.limits_note')}</p>
      </div>
    </Drawer>
  );
}
