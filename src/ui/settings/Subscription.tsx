'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownCircle, ArrowUpCircle, CalendarX } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney } from '@/shared/format';
import { PLAN_FEATURES } from '@/shared/plans';
import { api, ApiError } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, FormErrorSummary } from '../components/form';
import { Card } from '../components/layout';
import { ConfirmDialog, Dialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { cx } from '../components/cx';

type PlanInfo = { id: string; code: string; name_ar: string; name_en: string; description_ar: string | null; description_en: string | null; price_monthly_minor: number | null; price_is_test: boolean; currency: string; trial_days: number; sort: number; features?: Record<string, { enabled: boolean; limit: number | null }> };
type Overview = {
  subscription: null | { id: string; status: string; trial_ends_at: string | null; current_period_end: string | null; grace_until: string | null; cancel_at: string | null; paused_at: string | null; read_only: boolean; overage_state: null | { exceeded: Array<{ key: string; limit: number; used: number }> }; plan: PlanInfo };
  usage: Array<{ key: string; used: number; limit: number | null; enabled: boolean }>;
  plans: PlanInfo[];
  events: Array<{ id: string; kind: string; from_status: string | null; to_status: string | null; created_at: string }>;
  invoices: Array<{ id: string; number: string; amount_minor: number; currency: string; status: string; issued_at: string | null; is_test: boolean }>;
};
type Preview = { from: string; to: string; direction: 'upgrade' | 'downgrade' | 'same'; overages: Array<{ key: string; limit: number; used: number }>; requires_confirmation: boolean };

const featureLabel = (k: string, locale: 'ar' | 'en') => { const m = PLAN_FEATURES[k as keyof typeof PLAN_FEATURES]; return m ? (locale === 'ar' ? m.label_ar : m.label_en) : k; };

export function SubscriptionSection({ slug, canManage, tz }: { slug: string; canManage: boolean; tz: string }) {
  const { t, locale, pick, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useApiQuery<Overview>(['subscription', slug], `/api/v1/t/${slug}/subscription`);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  if (q.isLoading) return <LoadingState rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const s = d.subscription;
  const dt = (v: string | null) => (v ? formatDateTime(v, { locale, timeFormat, tz, time: false }) : '—');
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['subscription', slug] }), qc.invalidateQueries({ queryKey: ['branches', slug] })]);

  async function choose(code: string) {
    setErr(null); setAgree(false);
    try { setPreview(await api<Preview>(`/api/v1/t/${slug}/subscription/preview?plan_code=${code}`)); } catch (e) { setErr(e); }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/t/${slug}/subscription/change-plan`, { body: { plan_code: preview.to, confirm_overage: preview.requires_confirmation ? agree : undefined } });
      setPreview(null); toast({ tone: 'ok', text: t('biz_settings.sub.changed') }); await refresh();
      window.location.reload(); // entitlements are loaded per request; refresh navigation/features
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function cancel(action: 'cancel_at_period_end' | 'keep') {
    setBusy(true); setErr(null);
    try { await api(`/api/v1/t/${slug}/subscription/cancel`, { body: { action } }); setCancelOpen(false); toast({ tone: 'ok', text: t('states.saved') }); await refresh(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }

  if (!s) return <Alert tone="warn">{t('biz_settings.sub.none')}</Alert>;
  const current = ['trialing', 'active', 'past_due', 'paused'].includes(s.status);
  return (
    <div className="flex flex-col gap-4">
      <FormErrorSummary message={err && !(err instanceof ApiError && err.code === 'downgrade_confirmation_required') ? msg(err) : null} />
      <Card title={t('biz_settings.sub.current')}>
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-display text-2xl text-luma-700">{pick(s.plan.name_ar, s.plan.name_en)}</p>
          <Badge tone={s.status === 'active' ? 'ok' : s.status === 'trialing' ? 'info' : 'warn'}>{t(`platform.sub_status.${s.status}`)}</Badge>
          {s.cancel_at ? <Badge>{t('biz_settings.sub.cancels_on', { date: dt(s.cancel_at) })}</Badge> : null}
        </div>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          {s.status === 'trialing' ? <div><dt className="text-ink-muted">{t('platform.trial_ends')}</dt><dd className="font-medium">{dt(s.trial_ends_at)}</dd></div> : null}
          {s.current_period_end && s.status !== 'trialing' ? <div><dt className="text-ink-muted">{t('platform.period_end')}</dt><dd className="font-medium">{dt(s.current_period_end)}</dd></div> : null}
          {s.status === 'past_due' ? <div><dt className="text-ink-muted">{t('platform.subs.grace_until')}</dt><dd className="font-medium text-warn">{dt(s.grace_until)}</dd></div> : null}
          <div><dt className="text-ink-muted">{t('platform.subs.price')}</dt><dd className="font-medium">{s.plan.price_monthly_minor == null ? t('platform.pricing_not_configured') : <>{formatMoney(s.plan.price_monthly_minor, s.plan.currency, locale)} {s.plan.price_is_test ? <Badge tone="warn">{t('platform.test_label')}</Badge> : null}</>}</dd></div>
        </dl>
        {s.status === 'past_due' ? <Alert tone="warn" className="mt-3">{t('biz_settings.sub.past_due_note')}</Alert> : null}
        {s.read_only ? <Alert tone="danger" className="mt-3">{t('biz_settings.sub.read_only_note')}</Alert> : null}
        {s.overage_state ? (
          <Alert tone="warn" className="mt-3" title={t('biz_settings.sub.overage_title')}>
            <p>{t('biz_settings.sub.overage_body')}</p>
            <ul className="mt-1 list-disc ps-5">{s.overage_state.exceeded.map((o) => <li key={o.key}>{featureLabel(o.key, locale)}: {o.used} / {o.limit}</li>)}</ul>
          </Alert>
        ) : null}
        <p className="mt-3 text-xs text-ink-muted">{t('biz_settings.sub.no_charging')}</p>
      </Card>
      <Card title={t('biz_settings.sub.usage')}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {d.usage.map((u) => {
            const pct = u.limit == null ? 0 : u.limit === 0 ? 100 : Math.min(100, Math.round((u.used / u.limit) * 100));
            const over = u.limit !== null && u.used > u.limit;
            return (
              <li key={u.key} className="rounded-xl border border-line p-3">
                <p className="text-xs text-ink-muted">{featureLabel(u.key, locale)}</p>
                <p className={cx('font-semibold', over && 'text-warn')}>{u.used} / {u.limit == null ? t('site.unlimited') : u.limit}</p>
                {u.limit != null ? <div className="mt-1 h-1.5 rounded-full bg-luma-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={featureLabel(u.key, locale)}><div className={cx('h-full rounded-full', over ? 'bg-warn' : 'bg-luma-500')} style={{ width: `${pct}%` }} /></div> : null}
              </li>
            );
          })}
        </ul>
      </Card>
      {canManage && current ? (
        <Card title={t('biz_settings.sub.change')}>
          <div className="grid gap-3 md:grid-cols-3">
            {d.plans.map((p) => {
              const isCurrent = p.code === s.plan.code;
              const up = p.sort > s.plan.sort;
              return (
                <div key={p.id} className={cx('flex flex-col rounded-xl border p-4', isCurrent ? 'border-luma-500 bg-luma-50' : 'border-line')}>
                  <p className="font-display text-lg text-luma-700">{pick(p.name_ar, p.name_en)}</p>
                  <p className="text-xs text-ink-muted">{pick(p.description_ar, p.description_en)}</p>
                  <p className="mt-2 text-sm">{p.price_monthly_minor == null ? t('platform.pricing_not_configured') : formatMoney(p.price_monthly_minor, p.currency, locale)}{p.price_monthly_minor != null && p.price_is_test ? <Badge tone="warn" className="ms-1">{t('platform.test_label')}</Badge> : null}</p>
                  <ul className="mt-2 flex-1 text-xs text-ink-muted">{Object.entries(p.features ?? {}).filter(([k]) => k.startsWith('limit.')).map(([k, f]) => <li key={k}>{featureLabel(k, locale)}: {f.enabled ? (f.limit ?? t('site.unlimited')) : 0}</li>)}</ul>
                  {isCurrent ? <Badge tone="brand" className="mt-3 self-start">{t('biz_settings.sub.your_plan')}</Badge> : (
                    <Button size="sm" variant={up ? 'primary' : 'outline'} className="mt-3 self-start" icon={up ? <ArrowUpCircle className="size-4" /> : <ArrowDownCircle className="size-4" />} onClick={() => choose(p.code)}>
                      {up ? t('biz_settings.sub.upgrade') : t('biz_settings.sub.downgrade')}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-4 border-t border-line pt-3">
            {s.cancel_at ? (
              <Button variant="outline" loading={busy} onClick={() => cancel('keep')}>{t('biz_settings.sub.keep')}</Button>
            ) : (
              <Button variant="ghost" className="text-danger" icon={<CalendarX className="size-4" />} onClick={() => setCancelOpen(true)}>{t('biz_settings.sub.cancel')}</Button>
            )}
          </div>
        </Card>
      ) : null}
      {d.invoices.length ? (
        <Card title={t('platform.subs.invoices')}>
          <ul className="divide-y divide-line text-sm">{d.invoices.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="font-mono text-xs" dir="ltr">{i.number}</span>
              <span className="flex items-center gap-2">{formatMoney(i.amount_minor, i.currency, locale)}<Badge tone="warn">{t('platform.test_label')}</Badge><Badge tone={i.status === 'paid' ? 'ok' : 'neutral'}>{t(`platform.invoice_status.${i.status}`)}</Badge></span>
            </li>
          ))}</ul>
        </Card>
      ) : null}
      <Card title={t('platform.subs.history')}>
        <ul className="flex flex-col gap-1 text-sm">{d.events.map((e) => (
          <li key={e.id} className="flex justify-between gap-2"><span>{t(`biz_settings.sub.events.${e.kind.replace('platform.', 'platform_')}`)}</span><span className="text-xs text-ink-muted">{formatDateTime(e.created_at, { locale, timeFormat, tz })}</span></li>
        ))}</ul>
      </Card>

      <Dialog open={!!preview} onClose={() => setPreview(null)} title={preview?.direction === 'upgrade' ? t('biz_settings.sub.confirm_upgrade') : t('biz_settings.sub.confirm_downgrade')}
        footer={<><Button variant="ghost" onClick={() => setPreview(null)}>{t('actions.cancel')}</Button><Button loading={busy} disabled={!!preview?.requires_confirmation && !agree} onClick={apply}>{t('actions.confirm')}</Button></>}>
        {preview ? (
          <div className="flex flex-col gap-3">
            <p>{t('biz_settings.sub.change_to', { plan: t(`platform.plan_names.${preview.to}`) })}</p>
            {preview.direction === 'upgrade' ? <p className="text-ink-muted">{t('biz_settings.sub.upgrade_note')}</p> : null}
            {preview.overages.length ? (
              <Alert tone="warn" title={t('biz_settings.sub.overage_preview')}>
                <ul className="list-disc ps-5">{preview.overages.map((o) => <li key={o.key}>{featureLabel(o.key, locale)}: {t('biz_settings.sub.uses_of', { used: o.used, limit: o.limit })}</li>)}</ul>
                <p className="mt-2">{t('biz_settings.sub.overage_explain')}</p>
              </Alert>
            ) : preview.direction === 'downgrade' ? <p className="text-ink-muted">{t('biz_settings.sub.no_overage')}</p> : null}
            {preview.requires_confirmation ? <Checkbox label={t('biz_settings.sub.agree_overage')} checked={agree} onChange={setAgree} /> : null}
          </div>
        ) : null}
      </Dialog>
      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)} onConfirm={() => cancel('cancel_at_period_end')} loading={busy} danger
        title={t('biz_settings.sub.cancel')} body={t('biz_settings.sub.cancel_body', { date: dt(s.current_period_end ?? s.trial_ends_at) })} confirmLabel={t('biz_settings.sub.cancel')} />
    </div>
  );
}
