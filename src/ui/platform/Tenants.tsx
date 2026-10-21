'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, LifeBuoy, RotateCcw } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useDebounced, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Select, Textarea } from '../components/form';
import { Card, DataTable, PageHeader } from '../components/layout';
import { Dialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { PLAN_FEATURES } from '@/shared/plans';
import { KV, PageNav, SearchBox, SubStatus, TenantStatus, Toolbar, When, qs } from './common';
import { usePlatform } from './PlatformShell';
import { useStepUp } from './stepup';

type Row = { id: string; slug: string; name: string; status: string; business_type: string; city: string | null; created_at: string; is_demo: boolean; sub_status: string | null; trial_ends_at: string | null; plan_code: string | null; plan_name_ar: string | null; plan_name_en: string | null; owner_name: string | null; owner_email: string | null; overage_state: unknown };
type List = { items: Row[]; total: number; page: number; limit: number };
type Detail = {
  tenant: Record<string, any>; usage: Record<string, number>; counts: { members: number; bookings_30d: number; bookings_total: number; customers: number };
  limits: Array<{ feature_key: string; enabled: boolean; limit_value: number | null }>;
  support_grants: Array<{ id: string; reason: string; access_level: string; starts_at: string; expires_at: string; revoked_at: string | null; support_user: string }>;
};

export function ReasonDialog({ open, title, body, onClose, onConfirm, danger, confirmLabel }: { open: boolean; title: string; body?: string; onClose: () => void; onConfirm: (reason: string) => Promise<void>; danger?: boolean; confirmLabel?: string }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < 10} onClick={async () => {
        setBusy(true); setErr(null);
        try { await onConfirm(reason.trim()); setReason(''); } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>{confirmLabel ?? t('actions.confirm')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        {body ? <p className="text-ink-muted">{body}</p> : null}
        <FormErrorSummary message={err ? msg(err) : null} />
        <Field label={t('fields.reason')} hint={t('platform.reason_hint')} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}</Field>
      </div>
    </Dialog>
  );
}

export function TenantsPage({ initialQ = '' }: { initialQ?: string }) {
  const { t, pick } = useI18n();
  const { can } = usePlatform();
  const [q, setQ] = useState(initialQ);
  const [status, setStatus] = useState('');
  const [subStatus, setSubStatus] = useState('');
  const [plan, setPlan] = useState('');
  const [sort, setSort] = useState('created_desc');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q);
  const path = `/api/v1/platform/tenants${qs({ q: dq, status, sub_status: subStatus, plan, sort, page, limit: 25 })}`;
  const list = useApiQuery<List>(['platform', 'tenants', path], path);

  return (
    <div>
      <PageHeader title={t('platform.tenants.title')} subtitle={t('platform.tenants.subtitle')} />
      <Toolbar>
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} label={t('platform.tenants.search')} />
        <Select aria-label={t('fields.status')} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
          <option value="">{t('platform.all_statuses')}</option>
          {['onboarding', 'active', 'suspended', 'closed'].map((s) => <option key={s} value={s}>{t(`platform.tenant_status.${s}`)}</option>)}
        </Select>
        <Select aria-label={t('platform.subscription')} value={subStatus} onChange={(e) => { setSubStatus(e.target.value); setPage(1); }} className="w-auto">
          <option value="">{t('platform.all_subscriptions')}</option>
          {['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired'].map((s) => <option key={s} value={s}>{t(`platform.sub_status.${s}`)}</option>)}
        </Select>
        <Select aria-label={t('platform.plan')} value={plan} onChange={(e) => { setPlan(e.target.value); setPage(1); }} className="w-auto">
          <option value="">{t('platform.all_plans')}</option>
          {['sanaa', 'wahaj', 'fareed'].map((p) => <option key={p} value={p}>{t(`platform.plan_names.${p}`)}</option>)}
        </Select>
        <Select aria-label={t('platform.sort')} value={sort} onChange={(e) => setSort(e.target.value)} className="w-auto">
          {['created_desc', 'created_asc', 'name_asc', 'trial_end_asc'].map((s) => <option key={s} value={s}>{t(`platform.tenants.sort.${s}`)}</option>)}
        </Select>
      </Toolbar>
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data!.items.length ? <EmptyState title={t('platform.tenants.empty')} /> : (
        <>
          <DataTable rows={list.data!.items} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} caption={t('platform.tenants.title')} columns={[
            { key: 'name', header: t('fields.name'), cell: (r) => <div><p className="font-medium">{r.name}{r.is_demo ? <Badge className="ms-1">{t('platform.demo')}</Badge> : null}</p><p className="text-xs text-ink-muted" dir="ltr">/{r.slug}</p></div> },
            { key: 'status', header: t('fields.status'), cell: (r) => <TenantStatus status={r.status} /> },
            { key: 'plan', header: t('platform.plan'), cell: (r) => r.plan_code ? pick(r.plan_name_ar, r.plan_name_en) : '—' },
            { key: 'sub', header: t('platform.subscription'), cell: (r) => <div className="flex flex-col gap-0.5"><SubStatus status={r.sub_status} />{r.overage_state ? <Badge tone="warn">{t('platform.over_limit')}</Badge> : null}</div> },
            { key: 'trial', header: t('platform.trial_ends'), className: 'hidden md:table-cell', cell: (r) => <When v={r.trial_ends_at} time={false} /> },
            { key: 'owner', header: t('platform.owner'), className: 'hidden lg:table-cell', cell: (r) => <div className="text-xs"><p>{r.owner_name}</p><p className="text-ink-muted" dir="ltr">{r.owner_email}</p></div> },
            { key: 'created', header: t('platform.created'), className: 'hidden lg:table-cell', cell: (r) => <When v={r.created_at} time={false} /> },
          ]} />
          <PageNav page={page} total={list.data!.total} limit={25} onPage={setPage} />
        </>
      )}
      {open ? <TenantDrawer id={open} onClose={() => setOpen(null)} canManage={can('platform.tenants.manage')} canSupport={can('platform.support.access')} /> : null}
    </div>
  );
}

function TenantDrawer({ id, onClose, canManage, canSupport }: { id: string; onClose: () => void; canManage: boolean; canSupport: boolean }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const d = useApiQuery<Detail>(['platform', 'tenant', id], `/api/v1/platform/tenants/${id}`);
  const [dialog, setDialog] = useState<'suspended' | 'active' | null>(null);
  const tn = d.data?.tenant;
  return (
    <Drawer open onClose={onClose} wide title={tn?.name ?? t('states.loading')}>
      {d.isLoading ? <LoadingState /> : d.error ? <ErrorState error={d.error} onRetry={() => d.refetch()} /> : tn ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <TenantStatus status={tn.status} /><SubStatus status={tn.sub_status} />
            {tn.published ? <Badge tone="ok">{t('platform.tenants.published')}</Badge> : <Badge>{t('platform.tenants.not_published')}</Badge>}
          </div>
          <Card title={t('platform.tenants.profile')}>
            <dl>
              <KV label={t('platform.tenants.address')}><span dir="ltr">/{tn.slug}</span></KV>
              <KV label={t('platform.tenants.type')}>{t(`onboarding.types.${tn.business_type}`)}</KV>
              <KV label={t('platform.tenants.city')}>{tn.city ?? '—'}</KV>
              <KV label={t('platform.owner')}>{tn.owner_name} <span className="block text-xs text-ink-muted" dir="ltr">{tn.owner_email ?? tn.owner_phone}</span></KV>
              <KV label={t('platform.plan')}>{locale === 'ar' ? tn.plan_name_ar : tn.plan_name_en}</KV>
              <KV label={t('platform.trial_ends')}><When v={tn.trial_ends_at} /></KV>
              <KV label={t('platform.period_end')}><When v={tn.current_period_end} /></KV>
              <KV label={t('platform.created')}><When v={tn.created_at} /></KV>
            </dl>
          </Card>
          <Card title={t('platform.tenants.usage')}>
            <p className="mb-2 text-xs text-ink-muted">{t('platform.tenants.aggregates_only')}</p>
            <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {Object.entries(d.data!.usage).map(([k, v]) => {
                const l = d.data!.limits.find((x) => x.feature_key === k);
                const limit = l?.enabled ? l.limit_value : 0;
                const over = limit !== null && v > limit && k !== 'limit.ai_runs_monthly';
                return <li key={k} className="rounded-lg border border-line p-2"><p className="text-xs text-ink-muted">{locale === 'ar' ? PLAN_FEATURES[k as keyof typeof PLAN_FEATURES].label_ar : PLAN_FEATURES[k as keyof typeof PLAN_FEATURES].label_en}</p><p className={over ? 'font-semibold text-warn' : 'font-semibold'}>{v} / {limit ?? '∞'}</p></li>;
              })}
              <li className="rounded-lg border border-line p-2"><p className="text-xs text-ink-muted">{t('platform.tenants.members')}</p><p className="font-semibold">{d.data!.counts.members}</p></li>
              <li className="rounded-lg border border-line p-2"><p className="text-xs text-ink-muted">{t('platform.tenants.bookings_30d')}</p><p className="font-semibold">{d.data!.counts.bookings_30d}</p></li>
              <li className="rounded-lg border border-line p-2"><p className="text-xs text-ink-muted">{t('platform.tenants.customers')}</p><p className="font-semibold">{d.data!.counts.customers}</p></li>
            </ul>
          </Card>
          <Card title={t('platform.tenants.support_history')}>
            {d.data!.support_grants.length ? (
              <ul className="divide-y divide-line text-sm">{d.data!.support_grants.map((g) => (
                <li key={g.id} className="py-2"><p>{g.support_user} · <Badge tone={g.access_level === 'write' ? 'warn' : 'info'}>{t(`platform.support.level.${g.access_level}`)}</Badge></p><p className="text-xs text-ink-muted">{g.reason}</p><p className="text-xs text-ink-muted"><When v={g.starts_at} /> → <When v={g.expires_at} />{g.revoked_at ? ` · ${t('platform.support.revoked')}` : ''}</p></li>
              ))}</ul>
            ) : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
          </Card>
          <div className="flex flex-wrap gap-2">
            <Link href={`/platform/subscriptions?q=${tn.slug}`} className="rounded-lg border border-luma-300 px-3 py-2 text-sm text-luma-800 hover:bg-luma-50">{t('platform.tenants.view_subscription')}</Link>
            {canSupport ? <Link href={`/platform/support?tenant=${tn.slug}`} className="inline-flex items-center gap-1.5 rounded-lg border border-luma-300 px-3 py-2 text-sm text-luma-800 hover:bg-luma-50"><LifeBuoy className="size-4" />{t('platform.tenants.request_support')}</Link> : null}
            {canManage && tn.status !== 'suspended' && tn.status !== 'closed' ? <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => setDialog('suspended')}>{t('platform.tenants.suspend')}</Button> : null}
            {canManage && tn.status === 'suspended' ? <Button icon={<RotateCcw className="size-4" />} onClick={() => setDialog('active')}>{t('platform.tenants.reinstate')}</Button> : null}
          </div>
          <ReasonDialog open={!!dialog} danger={dialog === 'suspended'} title={dialog === 'suspended' ? t('platform.tenants.suspend') : t('platform.tenants.reinstate')}
            body={dialog === 'suspended' ? t('platform.tenants.suspend_body') : undefined} onClose={() => setDialog(null)}
            onConfirm={async (reason) => {
              await stepUp(() => api(`/api/v1/platform/tenants/${id}/status`, { body: { status: dialog, reason } }));
              setDialog(null); toast({ tone: 'ok', text: t('states.saved') });
              await qc.invalidateQueries({ queryKey: ['platform'] });
            }} />
        </div>
      ) : null}
    </Drawer>
  );
}
