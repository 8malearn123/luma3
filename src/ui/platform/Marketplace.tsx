'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { DateTime } from 'luxon';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Check, FileText, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input, Select, Switch } from '../components/form';
import { Card, DataTable, PageHeader, Stat, Tabs } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { KV, Money, Toolbar, When } from './common';
import { usePlatform } from './PlatformShell';
import { useStepUp } from './stepup';
import { ReasonDialog } from './Tenants';

const tone = (s: string | null) => (s === 'approved' || s === 'verified' ? 'ok' : s === 'pending' ? 'info' : s === 'rejected' ? 'danger' : 'neutral') as 'ok' | 'info' | 'danger' | 'neutral';
const TABS = ['requests', 'verification', 'fees', 'settings'] as const;
type Tab = (typeof TABS)[number];

/** LUMA admin → سوق لوما: join requests, verification queue, commission ledger, settings. */
export function MarketplaceAdminPage() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const raw = sp.get('tab') as Tab | null;
  const tab: Tab = raw && TABS.includes(raw) ? raw : 'requests';
  return (
    <div>
      <PageHeader title={t('market.admin.title')} subtitle={t('market.admin.subtitle')} />
      <Tabs value={tab} onChange={(v) => router.replace(`${pathname}?tab=${v}`, { scroll: false })} items={TABS.map((k) => ({ value: k, label: t(`market.admin.tabs.${k}`) }))} />
      {tab === 'requests' ? <Requests /> : null}
      {tab === 'verification' ? <Verifications /> : null}
      {tab === 'fees' ? <Fees /> : null}
      {tab === 'settings' ? <Settings /> : null}
    </div>
  );
}

type ListingRow = { tenant_id: string; slug: string; name: string; business_type: string; city: string | null; tenant_status: string; status: string; hidden: boolean; requested_at: string | null; reviewed_at: string | null; rejection_reason: string | null; commission_bp: number | null; verification_status: string | null; published: boolean };

function Requests() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const msg = useErrorMessage();
  const [status, setStatus] = useState('pending');
  const q = useApiQuery<{ items: ListingRow[] }>(['platform', 'market', 'listings', status], `/api/v1/platform/marketplace/listings${status ? `?status=${status}` : ''}`);
  const [rejecting, setRejecting] = useState<ListingRow | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const decide = async (id: string, decision: 'approve' | 'reject', reason?: string) => {
    setErr(null);
    try {
      await api(`/api/v1/platform/marketplace/listings/${id}/review`, { body: { decision, reason } });
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform', 'market'] });
    } catch (e) { setErr(e); throw e; }
  };
  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <Select aria-label={t('fields.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">{t('market.admin.all')}</option>
          {['pending', 'approved', 'rejected'].map((s) => <option key={s} value={s}>{t(`market.listing_status.${s}`)}</option>)}
        </Select>
      </Toolbar>
      <FormErrorSummary message={err ? msg(err) : null} />
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data!.items.length ? <EmptyState title={t('market.admin.no_requests')} /> : (
        <DataTable rows={q.data!.items} rowKey={(r) => r.tenant_id} caption={t('market.admin.tabs.requests')} columns={[
          { key: 'name', header: t('fields.name'), cell: (r) => <div><p className="font-medium">{r.name}</p><a className="text-xs text-luma-700 underline" href={`/s/${r.slug}`} target="_blank" rel="noopener" dir="ltr">/s/{r.slug}</a></div> },
          { key: 'type', header: t('market.admin.type'), cell: (r) => <span className="text-sm">{t(`market.types.${r.business_type}`)}{r.city ? ` · ${r.city}` : ''}</span> },
          { key: 'ver', header: t('market.admin.verification'), cell: (r) => <Badge tone={tone(r.verification_status)}>{t(`market.verification_status.${r.verification_status ?? 'draft'}`)}</Badge> },
          { key: 'st', header: t('fields.status'), cell: (r) => <div className="flex flex-col gap-1"><Badge tone={tone(r.status)}>{t(`market.listing_status.${r.status}`)}</Badge>{r.hidden ? <Badge>{t('market.admin.hidden')}</Badge> : null}{!r.published ? <Badge tone="warn">{t('market.blockers.not_published')}</Badge> : null}</div> },
          { key: 'at', header: t('market.admin.requested'), className: 'hidden md:table-cell', cell: (r) => <When v={r.requested_at} /> },
          { key: 'act', header: '', cell: (r) => r.status === 'pending' ? (
            <div className="flex gap-1.5">
              <Button size="sm" icon={<Check className="size-4" />} onClick={() => decide(r.tenant_id, 'approve').catch(() => undefined)}>{t('market.admin.approve')}</Button>
              <Button size="sm" variant="outline" icon={<X className="size-4" />} onClick={() => setRejecting(r)}>{t('market.admin.reject')}</Button>
            </div>
          ) : r.rejection_reason ? <span className="text-xs text-ink-muted">{r.rejection_reason}</span> : null },
        ]} />
      )}
      <ReasonDialog open={!!rejecting} danger title={t('market.admin.reject_listing', { name: rejecting?.name ?? '' })} body={t('market.admin.reason_shared')}
        onClose={() => setRejecting(null)} onConfirm={async (reason) => { await decide(rejecting!.tenant_id, 'reject', reason); setRejecting(null); }} />
    </div>
  );
}

type VerRow = { tenant_id: string; slug: string; name: string; business_type: string; city: string | null; status: string; submitted_at: string | null; reviewed_at: string | null; verified_at: string | null; rejection_reason: string | null };
type VerDetail = {
  tenant: { tenant_id: string; slug: string; name: string; business_type: string; city: string | null }; legal: { legal_name: string | null; tax_number: string | null } | null;
  verification: { status: string; submitted_at: string | null; rejection_reason: string | null };
  required: string[]; missing: string[];
  documents: Array<{ id: string; kind: string; mime: string; bytes: number; file_name: string | null; iban: string | null; created_at: string }>;
};

function Verifications() {
  const { t } = useI18n();
  const [status, setStatus] = useState('pending');
  const [open, setOpen] = useState<string | null>(null);
  const q = useApiQuery<{ items: VerRow[] }>(['platform', 'market', 'verifications', status], `/api/v1/platform/marketplace/verifications${status ? `?status=${status}` : ''}`);
  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <Select aria-label={t('fields.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">{t('market.admin.all')}</option>
          {['pending', 'verified', 'rejected'].map((s) => <option key={s} value={s}>{t(`market.verification_status.${s}`)}</option>)}
        </Select>
      </Toolbar>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data!.items.length ? <EmptyState title={t('market.admin.no_verifications')} /> : (
        <DataTable rows={q.data!.items} rowKey={(r) => r.tenant_id} onRowClick={(r) => setOpen(r.tenant_id)} caption={t('market.admin.tabs.verification')} columns={[
          { key: 'name', header: t('fields.name'), cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-ink-muted" dir="ltr">/{r.slug}</p></div> },
          { key: 'type', header: t('market.admin.type'), cell: (r) => t(`market.types.${r.business_type}`) },
          { key: 'st', header: t('fields.status'), cell: (r) => <Badge tone={tone(r.status)}>{t(`market.verification_status.${r.status}`)}</Badge> },
          { key: 'at', header: t('market.admin.submitted'), cell: (r) => <When v={r.submitted_at} /> },
        ]} />
      )}
      {open ? <VerificationDrawer tenantId={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function VerificationDrawer({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const msg = useErrorMessage();
  const d = useApiQuery<VerDetail>(['platform', 'market', 'verification', tenantId], `/api/v1/platform/marketplace/verifications/${tenantId}`);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const decide = async (decision: 'approve' | 'reject', reason?: string) => {
    setErr(null);
    await api(`/api/v1/platform/marketplace/verifications/${tenantId}/review`, { body: { decision, reason } });
    toast({ tone: 'ok', text: t('states.saved') });
    await qc.invalidateQueries({ queryKey: ['platform', 'market'] });
  };
  const v = d.data;
  return (
    <Drawer open onClose={onClose} wide title={v?.tenant.name ?? t('states.loading')}>
      {d.isLoading ? <LoadingState /> : d.error ? <ErrorState error={d.error} onRetry={() => d.refetch()} /> : v ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2"><Badge tone={tone(v.verification.status)}>{t(`market.verification_status.${v.verification.status}`)}</Badge><Badge>{t(`market.types.${v.tenant.business_type}`)}</Badge></div>
          <Alert tone="warn">{t('market.admin.sensitive')}</Alert>
          <Card title={t('market.admin.business')}>
            <dl>
              <KV label={t('market.admin.address')}><a className="text-luma-700 underline" href={`/s/${v.tenant.slug}`} target="_blank" rel="noopener" dir="ltr">/s/{v.tenant.slug}</a></KV>
              <KV label={t('market.admin.legal_name')}>{v.legal?.legal_name ?? '—'}</KV>
              <KV label={t('market.admin.tax_number')}><span dir="ltr">{v.legal?.tax_number ?? '—'}</span></KV>
              <KV label={t('market.admin.submitted')}><When v={v.verification.submitted_at} /></KV>
            </dl>
          </Card>
          <Card title={t('market.admin.documents')}>
            <ul className="flex flex-col gap-2">
              {v.required.map((k) => {
                const doc = v.documents.find((x) => x.kind === k);
                return (
                  <li key={k} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3 text-sm">
                    <FileText className="size-4 text-luma-700" aria-hidden />
                    <span className="flex-1 font-medium">{t(`market.docs.${k}`)}</span>
                    {doc ? (
                      <>
                        {doc.iban ? <span className="font-mono text-xs" dir="ltr">{doc.iban}</span> : null}
                        <a className="text-luma-700 underline" href={`/api/v1/platform/marketplace/documents/${doc.id}`} target="_blank" rel="noopener">{t('market.admin.open_doc')}</a>
                        <span className="text-xs text-ink-muted">{DateTime.fromISO(doc.created_at).setLocale(locale).toLocaleString(DateTime.DATE_MED)}</span>
                      </>
                    ) : <Badge tone="warn">{t('market.settings.missing')}</Badge>}
                  </li>
                );
              })}
            </ul>
          </Card>
          {v.verification.status === 'rejected' && v.verification.rejection_reason ? <Alert tone="danger" title={t('market.settings.verify_rejected')}>{v.verification.rejection_reason}</Alert> : null}
          <FormErrorSummary message={err ? msg(err) : null} />
          {v.verification.status === 'pending' ? (
            <div className="flex flex-wrap gap-2">
              <Button icon={<BadgeCheck className="size-4" />} loading={busy} disabled={v.missing.length > 0}
                onClick={async () => { setBusy(true); try { await decide('approve'); } catch (e) { setErr(e); } finally { setBusy(false); } }}>{t('market.admin.verify')}</Button>
              <Button variant="danger" icon={<X className="size-4" />} onClick={() => setRejecting(true)}>{t('market.admin.reject')}</Button>
            </div>
          ) : null}
          <ReasonDialog open={rejecting} danger title={t('market.admin.reject_verification')} body={t('market.admin.reason_shared')} onClose={() => setRejecting(false)}
            onConfirm={async (reason) => { await decide('reject', reason); setRejecting(false); }} />
        </div>
      ) : null}
    </Drawer>
  );
}

type FeesData = { from: string; to: string; total_fee_minor: number; total_bookings: number; items: Array<{ tenant_id: string; slug: string; name: string; currency: string; bookings: number; base_minor: number; fee_minor: number }> };

function Fees() {
  const { t } = useI18n();
  const now = DateTime.utc();
  const [from, setFrom] = useState(now.startOf('month').toISODate()!);
  const [to, setTo] = useState(now.toISODate()!);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const q = useApiQuery<FeesData>(['platform', 'market', 'fees', from, to], valid ? `/api/v1/platform/marketplace/fees?from=${from}&to=${to}` : null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <Field label={t('market.admin.from')}>{(p) => <Input {...p} type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('market.admin.to')}>{(p) => <Input {...p} type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Alert tone="info">{t('market.admin.fees_note')}</Alert>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label={t('market.finance.bookings')} value={q.data.total_bookings} />
            <Stat label={t('market.admin.total_fees')} value={<Money minor={q.data.total_fee_minor} />} />
          </div>
          {!q.data.items.length ? <EmptyState title={t('market.finance.empty')} /> : (
            <DataTable rows={q.data.items} rowKey={(r) => r.tenant_id} caption={t('market.admin.tabs.fees')} columns={[
              { key: 'name', header: t('fields.name'), cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-ink-muted" dir="ltr">/{r.slug}</p></div> },
              { key: 'n', header: t('market.finance.bookings'), cell: (r) => r.bookings },
              { key: 'base', header: t('market.finance.base'), cell: (r) => <Money minor={r.base_minor} currency={r.currency} /> },
              { key: 'fee', header: t('market.finance.fee'), cell: (r) => <span className="font-medium"><Money minor={r.fee_minor} currency={r.currency} /></span> },
            ]} />
          )}
        </>
      ) : null}
    </div>
  );
}

function Settings() {
  const { t } = useI18n();
  const { can } = usePlatform();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const msg = useErrorMessage();
  const q = useApiQuery<{ require_verification: boolean; default_commission_bp: number }>(['platform', 'market', 'settings'], '/api/v1/platform/marketplace/settings');
  const [draft, setDraft] = useState<{ require_verification: boolean; pct: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const v = draft ?? { require_verification: q.data!.require_verification, pct: String(q.data!.default_commission_bp / 100) };
  const manage = can('platform.marketplace.manage');
  const pctOk = /^\d{1,3}(\.\d{1,2})?$/.test(v.pct) && Number(v.pct) <= 100;
  return (
    <Card title={t('market.admin.settings_title')}>
      <div className="flex max-w-xl flex-col gap-4">
        <FormErrorSummary message={err ? msg(err) : null} />
        <Switch label={t('market.admin.require_verification')} checked={v.require_verification} disabled={!manage} onChange={(b) => setDraft({ ...v, require_verification: b })} />
        <p className="-mt-2 text-xs text-ink-muted">{t('market.admin.require_verification_hint')}</p>
        <Field label={t('market.admin.default_commission')} hint={t('market.admin.default_commission_hint')}>{(p) => (
          <div className="flex items-center gap-2"><Input {...p} type="number" min={0} max={100} step="0.01" dir="ltr" value={v.pct} disabled={!manage} onChange={(e) => setDraft({ ...v, pct: e.target.value })} className="w-32" /><span className="text-sm text-ink-muted">%</span></div>
        )}</Field>
        {manage ? <div><Button loading={busy} disabled={!draft || !pctOk} onClick={async () => {
          setBusy(true); setErr(null);
          try {
            await stepUp(() => api('/api/v1/platform/marketplace/settings', { method: 'PUT', body: { require_verification: v.require_verification, default_commission_bp: Math.round(Number(v.pct) * 100) } }));
            setDraft(null); toast({ tone: 'ok', text: t('states.saved') });
            await qc.invalidateQueries({ queryKey: ['platform', 'market'] });
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>{t('actions.save')}</Button></div> : <p className="text-xs text-ink-muted">{t('market.admin.owner_only')}</p>}
      </div>
    </Card>
  );
}
