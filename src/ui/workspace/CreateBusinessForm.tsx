'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useDebounced, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, Select } from '../components/form';
import { Alert } from '../components/feedback';
import { LumaLogo } from '../components/brand';
import { BUSINESS_TYPES } from '@/shared/onboarding';

type Plan = { code: string; name_ar: string; name_en: string; trial_days: number };

export function CreateBusinessForm({ verified, plans, initialPlan }: { verified: boolean; plans: Plan[]; initialPlan?: string }) {
  const { t, pick } = useI18n();
  const msg = useErrorMessage();
  const [f, setF] = useState({ name: '', slug: '', business_type: 'salon', city: '', branch_name: '', plan_code: initialPlan && plans.some((p) => p.code === initialPlan) ? initialPlan : plans[0]?.code ?? 'sanaa' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [avail, setAvail] = useState<boolean | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dName = useDebounced(f.name, 400);
  const dSlug = useDebounced(f.slug, 400);

  useEffect(() => {
    if (slugTouched || !dName) return;
    api<{ slug: string; available: boolean }>(`/api/v1/tenants/slug-check?name=${encodeURIComponent(dName)}`).then((r) => { setF((x) => ({ ...x, slug: r.slug })); setAvail(r.available); }).catch(() => {});
  }, [dName, slugTouched]);
  useEffect(() => {
    if (!slugTouched || !/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(dSlug)) { if (slugTouched) setAvail(null); return; }
    api<{ available: boolean }>(`/api/v1/tenants/slug-check?slug=${encodeURIComponent(dSlug)}`).then((r) => setAvail(r.available)).catch(() => {});
  }, [dSlug, slugTouched]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api<{ slug: string }>('/api/v1/tenants', { body: { ...f, city: f.city || undefined, branch_name: f.branch_name || undefined } });
      window.location.href = `/app/${r.slug}/onboarding`;
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }

  const issues = err instanceof ApiError && err.code === 'validation_failed' ? err.details?.issues : undefined;
  return (
    <div className="mx-auto max-w-xl p-6">
      <LumaLogo className="mb-6 h-10 w-auto" />
      <h1 className="mb-1 text-2xl font-semibold text-luma-900">{t('selector.create')}</h1>
      <p className="mb-5 text-sm text-ink-muted">{t('onboarding.steps.1.hint')}</p>
      {!verified ? <Alert tone="warn" className="mb-4">{t('errors.forbidden')}</Alert> : null}
      <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl bg-white p-5 shadow-sm">
        <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
        <Field label={t('onboarding.fields.business_name')} required>{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t('onboarding.fields.slug')} hint={t('onboarding.fields.slug_hint', { slug: f.slug || '…' })} error={avail === false ? t('errors.slug_taken') : null} required>
          {(p) => <Input {...p} dir="ltr" value={f.slug} onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }); }} />}
        </Field>
        <Field label={t('onboarding.fields.business_type')} required>
          {(p) => <Select {...p} value={f.business_type} onChange={(e) => setF({ ...f, business_type: e.target.value })}>{BUSINESS_TYPES.map((b) => <option key={b} value={b}>{t(`onboarding.types.${b}`)}</option>)}</Select>}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('onboarding.fields.city')}>{(p) => <Input {...p} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />}</Field>
          <Field label={t('onboarding.fields.branch_name')}>{(p) => <Input {...p} value={f.branch_name} onChange={(e) => setF({ ...f, branch_name: e.target.value })} />}</Field>
        </div>
        <Field label={t('onboarding.fields.plan')}>
          {(p) => <Select {...p} value={f.plan_code} onChange={(e) => setF({ ...f, plan_code: e.target.value })}>{plans.map((pl) => <option key={pl.code} value={pl.code}>{pick(pl.name_ar, pl.name_en)} · {t('onboarding.fields.trial', { days: pl.trial_days })}</option>)}</Select>}
        </Field>
        <Button type="submit" size="lg" loading={busy} disabled={!verified || !f.name || avail === false}>{t('onboarding.create_business')}</Button>
      </form>
    </div>
  );
}
