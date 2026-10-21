'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FilePlus2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useDebounced, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Card, DataTable, PageHeader } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { PLAN_FEATURES } from '@/shared/plans';
import { KV, Money, PageNav, SearchBox, SubStatus, TestBadge, Toolbar, When, qs } from './common';
import { usePlatform } from './PlatformShell';
import { useStepUp } from './stepup';

type Row = { id: string; status: string; trial_ends_at: string | null; current_period_end: string | null; grace_until: string | null; cancel_at: string | null; overage_state: any; tenant_id: string; slug: string; tenant_name: string; plan_code: string; plan_name_ar: string; plan_name_en: string };
type Invoice = { id: string; number: string; amount_minor: number; currency: string; status: string; period_start: string | null; period_end: string | null; issued_at: string | null; paid_at: string | null; is_test: boolean; note: string | null };
type Detail = {
  subscription: Row & { billing_cycle: string; current_period_start: string | null; paused_at: string | null; cancelled_at: string | null; grace_days: number; price_monthly_minor: number | null; price_is_test: boolean };
  events: Array<{ id: string; kind: string; from_status: string | null; to_status: string | null; data: Record<string, unknown>; created_at: string; actor_name: string | null }>;
  invoices: Invoice[]; usage: Record<string, number>;
};

const ACTIONS: Record<string, string[]> = {
  trialing: ['activate', 'extend_trial', 'mark_past_due', 'pause', 'cancel', 'expire', 'change_plan'],
  active: ['mark_past_due', 'pause', 'cancel', 'expire', 'change_plan'],
  past_due: ['activate', 'set_grace', 'extend_trial', 'pause', 'cancel', 'expire', 'change_plan'],
  paused: ['resume', 'cancel', 'expire', 'change_plan'],
  cancelled: ['reactivate'],
  expired: ['reactivate', 'extend_trial'],
};

export function SubscriptionsPage({ initial }: { initial: { status?: string; q?: string } }) {
  const { t, pick } = useI18n();
  const [status, setStatus] = useState(initial.status ?? '');
  const [q, setQ] = useState(initial.q ?? '');
  const [ending, setEnding] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q);
  const path = `/api/v1/platform/subscriptions${qs({ status, q: dq, trial_ending_days: ending, page, limit: 25 })}`;
  const list = useApiQuery<{ items: Row[]; total: number }>(['platform', 'subscriptions', path], path);
  return (
    <div>
      <PageHeader title={t('platform.subs.title')} subtitle={t('platform.subs.subtitle')} />
      <Toolbar>
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} label={t('platform.tenants.search')} />
        <Select aria-label={t('fields.status')} className="w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">{t('platform.all_statuses')}</option>
          {Object.keys(ACTIONS).map((s) => <option key={s} value={s}>{t(`platform.sub_status.${s}`)}</option>)}
        </Select>
        <Select aria-label={t('platform.subs.trial_ending')} className="w-auto" value={ending} onChange={(e) => { setEnding(e.target.value); setPage(1); }}>
          <option value="">{t('platform.subs.any_trial')}</option>
          {[3, 7, 14].map((d) => <option key={d} value={d}>{t('platform.subs.trial_within', { n: d })}</option>)}
        </Select>
      </Toolbar>
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data!.items.length ? <EmptyState /> : (
        <>
          <DataTable rows={list.data!.items} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} caption={t('platform.subs.title')} columns={[
            { key: 'tenant', header: t('platform.business'), cell: (r) => <div><p className="font-medium">{r.tenant_name}</p><p className="text-xs text-ink-muted" dir="ltr">/{r.slug}</p></div> },
            { key: 'plan', header: t('platform.plan'), cell: (r) => pick(r.plan_name_ar, r.plan_name_en) },
            { key: 'status', header: t('fields.status'), cell: (r) => <div className="flex flex-col gap-0.5"><SubStatus status={r.status} />{r.overage_state ? <Badge tone="warn">{t('platform.over_limit')}</Badge> : null}{r.cancel_at ? <Badge>{t('platform.subs.cancel_scheduled')}</Badge> : null}</div> },
            { key: 'trial', header: t('platform.trial_ends'), className: 'hidden md:table-cell', cell: (r) => <When v={r.trial_ends_at} time={false} /> },
            { key: 'period', header: t('platform.period_end'), className: 'hidden md:table-cell', cell: (r) => <When v={r.current_period_end} time={false} /> },
            { key: 'grace', header: t('platform.subs.grace_until'), className: 'hidden lg:table-cell', cell: (r) => <When v={r.grace_until} time={false} /> },
          ]} />
          <PageNav page={page} total={list.data!.total} limit={25} onPage={setPage} />
        </>
      )}
      {open ? <SubscriptionDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function SubscriptionDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, pick, locale } = useI18n();
  const { can } = usePlatform();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const d = useApiQuery<Detail>(['platform', 'subscription', id], `/api/v1/platform/subscriptions/${id}`);
  const [action, setAction] = useState('');
  const [days, setDays] = useState('7');
  const [plan, setPlan] = useState('wahaj');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const manage = can('platform.subscriptions.manage');

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await stepUp(fn); toast({ tone: 'ok', text: t('states.saved') }); setReason(''); setAction(''); await qc.invalidateQueries({ queryKey: ['platform'] }); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const s = d.data?.subscription;
  return (
    <Drawer open onClose={onClose} wide title={s ? `${s.tenant_name} · ${pick(s.plan_name_ar, s.plan_name_en)}` : t('states.loading')}>
      {d.isLoading ? <LoadingState /> : d.error ? <ErrorState error={d.error} onRetry={() => d.refetch()} /> : s ? (
        <div className="flex flex-col gap-4">
          <FormErrorSummary message={err ? msg(err) : null} />
          <Card>
            <dl>
              <KV label={t('fields.status')}><SubStatus status={s.status} /></KV>
              <KV label={t('platform.subs.cycle')}>{t(`platform.subs.cycles.${s.billing_cycle}`)}</KV>
              <KV label={t('platform.subs.price')}><Money minor={s.price_monthly_minor} />{s.price_monthly_minor != null && s.price_is_test ? <TestBadge /> : null}</KV>
              <KV label={t('platform.trial_ends')}><When v={s.trial_ends_at} /></KV>
              <KV label={t('platform.subs.period')}><When v={s.current_period_start} time={false} /> → <When v={s.current_period_end} time={false} /></KV>
              <KV label={t('platform.subs.grace_until')}><When v={s.grace_until} /> <span className="text-xs text-ink-muted">({t('platform.subs.grace_days', { n: s.grace_days })})</span></KV>
              {s.cancel_at ? <KV label={t('platform.subs.cancel_scheduled')}><When v={s.cancel_at} /></KV> : null}
              {s.paused_at ? <KV label={t('platform.sub_status.paused')}><When v={s.paused_at} /></KV> : null}
            </dl>
            {s.overage_state ? (
              <Alert tone="warn" className="mt-3" title={t('platform.over_limit')}>
                <ul>{(s.overage_state.exceeded ?? []).map((o: any) => <li key={o.key}>{locale === 'ar' ? PLAN_FEATURES[o.key as keyof typeof PLAN_FEATURES]?.label_ar : PLAN_FEATURES[o.key as keyof typeof PLAN_FEATURES]?.label_en}: {o.used} / {o.limit}</li>)}</ul>
              </Alert>
            ) : null}
          </Card>
          {manage ? (
            <Card title={t('platform.subs.actions')}>
              <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); run(() => api(`/api/v1/platform/subscriptions/${id}/actions`, { body: { action, reason, ...(['extend_trial', 'set_grace'].includes(action) ? { days: Number(days) } : {}), ...(action === 'change_plan' ? { plan_code: plan } : {}) } })); }}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('platform.subs.action')} required>{(p) => (
                    <Select {...p} value={action} onChange={(e) => setAction(e.target.value)}>
                      <option value="">—</option>
                      {(ACTIONS[s.status] ?? []).map((a) => <option key={a} value={a}>{t(`platform.subs.action_names.${a}`)}</option>)}
                    </Select>
                  )}</Field>
                  {['extend_trial', 'set_grace'].includes(action) ? <Field label={t('platform.subs.days')}>{(p) => <Input {...p} type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />}</Field> : null}
                  {action === 'change_plan' ? <Field label={t('platform.plan')}>{(p) => <Select {...p} value={plan} onChange={(e) => setPlan(e.target.value)}>{['sanaa', 'wahaj', 'fareed'].map((c) => <option key={c} value={c}>{t(`platform.plan_names.${c}`)}</option>)}</Select>}</Field> : null}
                </div>
                {action ? <p className="text-xs text-ink-muted">{t(`platform.subs.action_help.${action}`)}</p> : null}
                <Field label={t('fields.reason')} hint={t('platform.reason_hint')} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}</Field>
                <Button type="submit" className="self-start" loading={busy} disabled={!action || reason.trim().length < 10}>{t('actions.apply')}</Button>
              </form>
            </Card>
          ) : null}
          <Card title={t('platform.subs.invoices')} actions={manage ? <Button size="sm" variant="outline" icon={<FilePlus2 className="size-4" />} loading={busy} onClick={() => run(() => api(`/api/v1/platform/subscriptions/${id}/invoices`, { body: {} }))}>{t('platform.subs.issue_test_invoice')}</Button> : null}>
            <p className="mb-2 text-xs text-ink-muted">{t('platform.subs.invoices_note')}</p>
            {d.data!.invoices.length ? (
              <ul className="divide-y divide-line text-sm">{d.data!.invoices.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div><p className="font-mono text-xs" dir="ltr">{i.number}</p><p className="text-xs text-ink-muted">{i.period_start} → {i.period_end}</p></div>
                  <div className="flex items-center gap-2"><Money minor={i.amount_minor} currency={i.currency} /><TestBadge /><Badge tone={i.status === 'paid' ? 'ok' : i.status === 'open' ? 'warn' : 'neutral'}>{t(`platform.invoice_status.${i.status}`)}</Badge>
                    {manage && i.status === 'open' ? <>
                      <Button size="sm" onClick={() => run(() => api(`/api/v1/platform/invoices/${i.id}`, { body: { action: 'mark_paid' } }))}>{t('platform.subs.mark_paid')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => run(() => api(`/api/v1/platform/invoices/${i.id}`, { body: { action: 'void' } }))}>{t('platform.subs.void')}</Button>
                    </> : null}
                  </div>
                </li>
              ))}</ul>
            ) : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
          </Card>
          <Card title={t('platform.subs.history')}>
            <ol className="flex flex-col gap-2 border-s border-line ps-4 text-sm">
              {d.data!.events.map((e) => (
                <li key={e.id}>
                  <p className="font-medium"><span className="font-mono text-xs" dir="ltr">{e.kind}</span>{e.from_status !== e.to_status && e.to_status ? <span className="ms-2 text-xs text-ink-muted">{t(`platform.sub_status.${e.from_status}`)} → {t(`platform.sub_status.${e.to_status}`)}</span> : null}</p>
                  <p className="text-xs text-ink-muted"><When v={e.created_at} /> · {e.actor_name ?? t('platform.actor_kind.system')}{typeof e.data?.reason === 'string' ? ` · ${e.data.reason}` : ''}</p>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-ink-muted">{t('platform.subs.append_only')}</p>
          </Card>
        </div>
      ) : null}
    </Drawer>
  );
}
