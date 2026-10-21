'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDate, formatMoney } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, Input, MoneyInput, Select } from '../components/form';
import { loomKey, SourceBadge, useAct } from './loom-shared';

const STATUSES = ['open', 'deferred', 'accepted', 'dismissed', 'expired', 'superseded'] as const;

export function LoomRecommendations() {
  const { t } = useI18n();
  const access = useAccess();
  const [status, setStatus] = useState<string>('');
  const r = useApiQuery<any[]>(loomKey(access.slug, 'recs', status), access.api(`/marketing/recommendations${status ? `?status=${status}` : ''}`));
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('marketing.rec.status_filter')} className="w-56">
        {(p) => <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('marketing.rec_status.open')} + {t('marketing.rec_status.deferred')}</option>{STATUSES.map((s) => <option key={s} value={s}>{t(`marketing.rec_status.${s}`)}</option>)}</Select>}
      </Field>
      {r.isLoading ? <LoadingState rows={3} /> : r.error ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : !r.data!.length ? <EmptyState title={t('marketing.rec.empty')} /> : (
        <ul className="flex flex-col gap-3">{r.data!.map((x) => <RecCard key={x.id} r={x} />)}</ul>
      )}
    </div>
  );
}

function RecCard({ r }: { r: any }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { act, busy } = useAct();
  const [open, setOpen] = useState(false);
  const [deferTo, setDeferTo] = useState('');
  const [price, setPrice] = useState<{ service_id: string; minor: number | null }>({ service_id: r.draft_content?.service_ids?.[0] ?? '', minor: null });
  const canManage = access.can('marketing.manage');
  const services = useApiQuery<any[]>(['services', access.slug], open && r.category === 'pricing' && access.can('catalog.edit') ? access.api('/services') : null);
  const decide = (decision: string, extra: Record<string, unknown> = {}) => act(`${decision}`, `/marketing/recommendations/${r.id}/decision`, { body: { decision, ...extra } });
  const flagged = r.validation?.status === 'flagged';
  return (
    <li className="rounded-2xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold" dir="auto">{r.title}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge>{t(`marketing.rec.category.${r.category}`)}</Badge>
            <Badge>{t(`marketing.rec.horizon.${r.horizon}`)}</Badge>
            <Badge tone={r.confidence === 'high' ? 'ok' : r.confidence === 'medium' ? 'info' : 'warn'}>{t(`marketing.rec.confidence.${r.confidence}`)}</Badge>
            <SourceBadge source={r.source_type} />
            <Badge>{t(`marketing.rec_status.${r.status}`)}</Badge>
          </div>
        </div>
        <Button size="sm" variant="ghost" aria-expanded={open} icon={open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />} onClick={() => setOpen(!open)}>{open ? t('marketing.actions.hide_details') : t('marketing.actions.details')}</Button>
      </div>
      <p className="mt-2 text-sm" dir="auto"><span className="font-medium">{t('marketing.rec.opportunity')}:</span> {r.opportunity}</p>
      <p className="mt-1 text-sm" dir="auto"><span className="font-medium">{t('marketing.rec.action')}:</span> {r.suggested_action}</p>
      {flagged ? <Alert tone="warn" className="mt-2">{t('marketing.rec.validation_flagged')} {r.validation.unsupported_numbers?.length ? t('marketing.rec.unsupported_numbers', { list: r.validation.unsupported_numbers.join(', ') }) : ''}</Alert> : null}
      {open ? (
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div className="sm:col-span-2">
            <p className="font-medium">{t('marketing.rec.evidence')}</p>
            <ul className="mt-1 flex flex-col gap-1">
              {Object.entries(r.measured_metrics as Record<string, any>).map(([k, m]) => (
                <li key={k} className="flex flex-wrap items-center gap-2 text-xs"><span className="font-mono" dir="ltr">{k}</span><span dir="ltr">= {m.value ?? '—'}</span>
                  <Badge tone={m.supported ? 'ok' : 'warn'}>{m.supported ? t('marketing.rec.supported') : `${t('marketing.rec.unsupported')} (${m.claimed})`}</Badge></li>
              ))}
            </ul>
          </div>
          <Detail label={t('marketing.rec.timing')} value={r.timing} />
          <Detail label={t('marketing.rec.cost')} value={r.estimated_cost.status === 'unknown' ? `${t('marketing.rec.cost_unknown')} — ${r.estimated_cost.assumptions ?? ''}` : `${r.estimated_cost.amount_minor != null ? formatMoney(r.estimated_cost.amount_minor, access.currency, locale) : ''} ${r.estimated_cost.assumptions ?? ''}`} />
          <Detail label={t('marketing.rec.capacity')} value={t(`marketing.rec.capacity_status.${r.capacity_check.status}`)} />
          <Detail label={t('marketing.rec.margin')} value={t(`marketing.rec.margin_status.${r.margin_check.status}`)} tone={r.margin_check.status === 'costs_incomplete' || r.margin_check.status === 'low_margin' ? 'warn' : undefined} />
          {r.prerequisites?.length ? <Detail label={t('marketing.rec.prerequisites')} value={r.prerequisites.join(' • ')} /> : null}
          <Detail label={t('marketing.rec.success')} value={r.success_metric} />
          <Detail label={t('marketing.rec.experiment')} value={r.experiment_design} />
          <Detail label={t('marketing.rec.target')} value={r.proposed_target ? `${r.proposed_target} — ${t('marketing.plan.target_note')}` : '—'} />
          <Detail label={t('marketing.rec.forecast')} value={r.forecast ?? t('marketing.rec.no_forecast')} />
          <Detail label={t('marketing.rec.limitations')} value={r.limitations || '—'} />
          {r.draft_content?.text ? <Detail label={t('marketing.rec.draft')} value={r.draft_content.text} /> : null}
          <p className="text-xs text-ink-muted sm:col-span-2">
            {t('marketing.plan.data_as_of', { time: formatDate(r.data_as_of, { locale, tz: access.timezone }) })}
            {r.review_at ? ` • ${t('marketing.rec.review_at', { date: formatDate(r.review_at, { locale, tz: access.timezone }) })}` : ''}
            {r.provider ? ` • ${r.provider}/${r.model}/${r.prompt_version}` : ` • ${r.prompt_version}`}
          </p>
          {canManage && r.category === 'pricing' && access.can('catalog.edit') && r.draft_content?.service_ids?.length ? (
            <form className="flex flex-wrap items-end gap-2 rounded-lg bg-luma-50 p-3 sm:col-span-2" onSubmit={async (e) => { e.preventDefault(); if (price.minor !== null) await act('price', `/marketing/recommendations/${r.id}/price-proposal`, { body: { service_id: price.service_id, proposed_price_minor: price.minor }, ok: t('marketing.rec.proposal_created') }); }}>
              <p className="w-full text-xs text-ink-muted">{t('marketing.rec.price_hint')}</p>
              <Field label={t('marketing.rec.service')} className="w-56">{(p) => <Select {...p} value={price.service_id} onChange={(e) => setPrice({ ...price, service_id: e.target.value })}>{r.draft_content.service_ids.map((id: string) => { const s = services.data?.find((x) => x.id === id); return <option key={id} value={id}>{s ? (locale === 'ar' ? s.name_ar || s.name_en : s.name_en || s.name_ar) : id.slice(0, 8)}</option>; })}</Select>}</Field>
              <Field label={t('marketing.rec.new_price')} className="w-40">{(p) => <MoneyInput {...p} value={price.minor} onChange={(v) => setPrice({ ...price, minor: v })} />}</Field>
              <Button type="submit" variant="outline" loading={busy === 'price'} disabled={price.minor === null}>{t('marketing.actions.create_proposal')}</Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {canManage && ['open', 'deferred'].includes(r.status) ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Button size="sm" loading={busy === 'accepted'} onClick={() => decide('accepted')}>{t('marketing.actions.accept')}</Button>
          <Button size="sm" variant="ghost" loading={busy === 'dismissed'} onClick={() => decide('dismissed')}>{t('marketing.actions.dismiss')}</Button>
          <label className="sr-only" htmlFor={`defer-${r.id}`}>{t('marketing.rec.defer_date')}</label>
          <div className="w-44"><Input id={`defer-${r.id}`} type="date" dir="ltr" className="h-8" value={deferTo} onChange={(e) => setDeferTo(e.target.value)} /></div>
          <Button size="sm" variant="outline" loading={busy === 'deferred'} onClick={() => decide('deferred', deferTo ? { review_at: deferTo } : {})}>{t('marketing.actions.defer_until')}</Button>
          {access.hasFeature('feature.campaigns') ? <Button size="sm" variant="secondary" loading={busy === 'camp'} onClick={() => act('camp', `/marketing/recommendations/${r.id}/campaign-draft`, { body: {}, ok: t('marketing.rec.created_campaign') })}>{t('marketing.actions.to_campaign')}</Button> : null}
        </div>
      ) : canManage && ['accepted', 'dismissed'].includes(r.status) ? (
        <div className="mt-3"><Button size="sm" variant="ghost" loading={busy === 'open'} onClick={() => decide('open')}>{t('marketing.actions.reopen_rec')}</Button></div>
      ) : null}
    </li>
  );
}

function Detail({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return <div><p className="text-xs font-medium text-ink-muted">{label}</p><p className={tone === 'warn' ? 'text-warn' : undefined} dir="auto">{value}</p></div>;
}
