'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { FileWarning, Gavel, Lightbulb, Plus, Search } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, tzLabel } from '@/shared/format';
import { useApiQuery, useDebounced } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, Input, Select } from '../components/form';
import { DataTable, PageHeader, Pager, Tabs, type Column } from '../components/layout';
import { ActionBadge, DecisionStatus, IncidentStatus } from './labels';
import { IncidentDrawer, NewIncidentDrawer } from './IncidentDrawers';
import { DecisionDrawer, NewDecisionDrawer, type DecisionPrefill } from './DecisionDrawers';
import { RulesPanel } from './RulesPanel';
import { AppealsPanel } from './AppealsPanel';
import { useCursorStack } from './paging';

type Tab = 'incidents' | 'decisions' | 'rules' | 'appeals';
type IncidentRow = { id: string; type: string; status: string; occurred_at: string; customer_name: string; booking_number: string | null; escalation_status: string | null; summary: string };
type DecisionRow = { id: string; action: string; status: string; customer_name: string; effective_at: string; expires_at: string | null; review_flagged_at?: string | null; is_experimental: boolean; tenant_customer_id: string };
type Paged<T> = { items: T[]; next_cursor: string | null };

export function PoliciesPage() {
  const { t } = useI18n();
  const access = useAccess();
  const reviewer = access.can('incidents.review');
  // Deep links from notifications and the CRM: ?tab=, ?incident=, ?decision=, ?customer=
  const sp = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const tb = sp.get('tab') as Tab | null;
    if (reviewer && (sp.get('decision') || sp.get('customer'))) return 'decisions';
    return tb && ['incidents', 'decisions', 'rules', 'appeals'].includes(tb) && (tb === 'incidents' || reviewer) ? tb : 'incidents';
  });
  const [incidentId, setIncidentId] = useState<string | null>(() => sp.get('incident'));
  const [decisionId, setDecisionId] = useState<string | null>(() => (reviewer ? sp.get('decision') : null));
  const [customerFilter, setCustomerFilter] = useState<string | null>(() => (reviewer ? sp.get('customer') : null));
  const [newDecision, setNewDecision] = useState<DecisionPrefill | null>(null);

  const items: Array<{ value: Tab; label: string }> = [{ value: 'incidents', label: t('policy.tabs.incidents') }];
  if (reviewer) items.push({ value: 'decisions', label: t('policy.tabs.decisions') }, { value: 'rules', label: t('policy.tabs.rules') }, { value: 'appeals', label: t('policy.tabs.appeals') });

  return (
    <div>
      <PageHeader title={t('policy.title')} subtitle={t('policy.subtitle')} />
      <Alert tone="info" className="mb-4">{t('policy.one_report_note')}</Alert>
      <Tabs value={tab} onChange={setTab} items={items} />
      {tab === 'incidents' ? <IncidentsTab onOpen={setIncidentId} /> : null}
      {tab === 'decisions' && reviewer ? <DecisionsTab customerFilter={customerFilter} clearCustomer={() => setCustomerFilter(null)} onOpen={setDecisionId} onNew={(p) => setNewDecision(p)} /> : null}
      {tab === 'rules' && reviewer ? <RulesPanel /> : null}
      {tab === 'appeals' && reviewer ? <AppealsPanel /> : null}
      {incidentId ? <IncidentDrawer id={incidentId} onClose={() => setIncidentId(null)} onCreateDecision={(p) => { setIncidentId(null); setNewDecision(p); }} /> : null}
      {decisionId ? <DecisionDrawer id={decisionId} onClose={() => setDecisionId(null)} onSupersede={(p) => { setDecisionId(null); setNewDecision(p); }} /> : null}
      {newDecision ? <NewDecisionDrawer prefill={newDecision} onClose={() => setNewDecision(null)} onCreated={(id) => { setNewDecision(null); setTab('decisions'); setDecisionId(id); }} /> : null}
    </div>
  );
}

function IncidentsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('');
  const [escalated, setEscalated] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [sort, setSort] = useState('recent');
  const pager = useCursorStack([status, type, escalated, dq, sort].join('|'));
  const [creating, setCreating] = useState(false);
  const params = new URLSearchParams({ status, sort, limit: '25' });
  if (type) params.set('type', type);
  if (escalated) params.set('escalated', '1');
  if (dq) params.set('q', dq);
  if (pager.cursor) params.set('cursor', pager.cursor);
  const list = useApiQuery<Paged<IncidentRow>>(['incidents', access.slug, params.toString()], access.api(`/policies/incidents?${params}`));
  const columns: Column<IncidentRow>[] = [
    { key: 'type', header: t('fields.category'), cell: (r) => <span className="font-medium">{t(`policy.types.${r.type}`)}</span> },
    { key: 'customer', header: t('policy.customer_id'), cell: (r) => r.customer_name },
    { key: 'when', header: t('policy.occurred_at'), className: 'hidden sm:table-cell', cell: (r) => formatDateTime(r.occurred_at, { locale, tz: access.timezone, timeFormat }) },
    { key: 'booking', header: t('policy.booking'), className: 'hidden md:table-cell', cell: (r) => (r.booking_number ? <span dir="ltr" className="font-mono text-xs">{r.booking_number}</span> : '—') },
    { key: 'status', header: t('fields.status'), cell: (r) => (
      <div className="flex flex-wrap gap-1"><IncidentStatus status={r.status} />{r.escalation_status ? <Badge tone="info">{t(`policy.escalation.${r.escalation_status}`)}</Badge> : null}</div>
    ) },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-52 flex-1">
          <label htmlFor="inc-search" className="sr-only">{t('actions.search')}</label>
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" aria-hidden />
          <Input id="inc-search" type="search" className="ps-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('actions.search')} />
        </div>
        <Field label={t('fields.status')} className="min-w-36">{(p) => <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>{['all', 'submitted', 'under_review', 'confirmed', 'corrected', 'rejected'].map((s) => <option key={s} value={s}>{t(`policy.statuses.${s}`)}</option>)}</Select>}</Field>
        <Field label={t('fields.category')} className="min-w-36">{(p) => <Select {...p} value={type} onChange={(e) => setType(e.target.value)}><option value="">{t('policy.rules.any_type')}</option>{['no_show', 'late_cancellation', 'payment_dispute', 'conduct', 'other'].map((s) => <option key={s} value={s}>{t(`policy.types.${s}`)}</option>)}</Select>}</Field>
        <Field label={t('customers.sort.label')} className="min-w-36">{(p) => <Select {...p} value={sort} onChange={(e) => setSort(e.target.value)}><option value="recent">{t('customers.sort.recent')}</option><option value="occurred">{t('policy.occurred_at')}</option></Select>}</Field>
        <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-luma-700" checked={escalated} onChange={(e) => setEscalated(e.target.checked)} />{t('policy.escalation.pending')}</label>
        {access.can('incidents.submit') && !access.readOnly ? <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('policy.new_incident')}</Button> : null}
      </div>
      <p className="text-xs text-ink-muted">{t('time.tz_note', { tz: tzLabel(access.timezone, locale) })}</p>
      {list.isLoading ? <LoadingState rows={5} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.items.length ? <EmptyState icon={<FileWarning className="size-8" aria-hidden />} /> : (
        <>
          <DataTable rows={list.data.items} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => onOpen(r.id)} caption={t('policy.tabs.incidents')} />
          <Pager hasPrev={pager.hasPrev} hasNext={!!list.data.next_cursor} onPrev={pager.prev} onNext={() => pager.next(list.data!.next_cursor!)} />
        </>
      )}
      {creating ? <NewIncidentDrawer onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} /> : null}
    </div>
  );
}

function DecisionsTab({ customerFilter, clearCustomer, onOpen, onNew }: { customerFilter: string | null; clearCustomer: () => void; onOpen: (id: string) => void; onNew: (p: DecisionPrefill) => void }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const [status, setStatus] = useState('active');
  const [due, setDue] = useState(false);
  const pager = useCursorStack(`${status}|${due}|${customerFilter}`);
  const params = new URLSearchParams({ status, limit: '25' });
  if (due) params.set('review_due', '1');
  if (customerFilter) params.set('tenant_customer_id', customerFilter);
  if (pager.cursor) params.set('cursor', pager.cursor);
  const list = useApiQuery<Paged<DecisionRow>>(['decisions', access.slug, params.toString()], access.api(`/policies/decisions?${params}`));
  const sugg = useApiQuery<{ suggestions: Array<{ rule_id: string; key: string; suggested_action: string; matched_incidents: number; is_experimental: boolean }> }>(
    ['suggestions', access.slug, customerFilter], customerFilter ? access.api(`/policies/suggestions?tenant_customer_id=${customerFilter}`) : null);
  const columns: Column<DecisionRow>[] = [
    { key: 'customer', header: t('policy.decisions.customer'), cell: (r) => <span className="font-medium">{r.customer_name}</span> },
    { key: 'action', header: t('policy.decisions.action'), cell: (r) => <div className="flex flex-wrap gap-1"><ActionBadge action={r.action} />{r.is_experimental ? <Badge tone="warn">{t('policy.decisions.experimental')}</Badge> : null}</div> },
    { key: 'from', header: t('policy.decisions.effective_at'), className: 'hidden sm:table-cell', cell: (r) => formatDateTime(r.effective_at, { locale, tz: access.timezone, time: false }) },
    { key: 'to', header: t('policy.decisions.expires_at'), className: 'hidden md:table-cell', cell: (r) => (r.expires_at ? formatDateTime(r.expires_at, { locale, tz: access.timezone, time: false }) : '—') },
    { key: 'status', header: t('fields.status'), cell: (r) => <div className="flex flex-wrap gap-1"><DecisionStatus status={r.status} />{r.review_flagged_at && r.status === 'active' ? <Badge tone="danger">{t('policy.decisions.review_due')}</Badge> : null}</div> },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('fields.status')} className="min-w-36">{(p) => <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>{['active', 'superseded', 'revoked', 'expired', 'all'].map((s) => <option key={s} value={s}>{t(`policy.decisions.status.${s}`)}</option>)}</Select>}</Field>
        <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-luma-700" checked={due} onChange={(e) => setDue(e.target.checked)} />{t('policy.decisions.review_due')}</label>
        {customerFilter ? <Button variant="outline" size="sm" onClick={clearCustomer}>{t('actions.clear')}: {t('policy.decisions.customer')}</Button> : null}
        <div className="flex-1" />
        {!access.readOnly ? <Button icon={<Gavel className="size-4" />} onClick={() => onNew({ tenantCustomerId: customerFilter ?? undefined })}>{t('policy.decisions.new')}</Button> : null}
      </div>
      {sugg.data?.suggestions.length ? (
        <div className="rounded-xl border border-warn/30 bg-warn-bg/50 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium"><Lightbulb className="size-4" aria-hidden />{t('policy.suggestions')}</p>
          <p className="text-xs text-ink-muted">{t('policy.suggestions_note')}</p>
          <ul className="mt-2 flex flex-col gap-1">
            {sugg.data.suggestions.map((s) => (
              <li key={s.rule_id} className="flex flex-wrap items-center gap-2">
                <ActionBadge action={s.suggested_action} /><span>{s.key}</span><span className="text-ink-muted">{t('policy.matched', { n: s.matched_incidents })}</span>
                {s.is_experimental ? <Badge tone="warn">{t('policy.decisions.experimental')}</Badge> : null}
                <Button size="sm" variant="ghost" onClick={() => onNew({ tenantCustomerId: customerFilter!, action: s.suggested_action, ruleId: s.rule_id, experimental: s.is_experimental })}>{t('policy.use_suggestion')}</Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {list.isLoading ? <LoadingState rows={4} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.items.length ? <EmptyState title={t('policy.decisions.none')} icon={<Gavel className="size-8" aria-hidden />} /> : (
        <>
          <DataTable rows={list.data.items} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => onOpen(r.id)} caption={t('policy.tabs.decisions')} />
          <Pager hasPrev={pager.hasPrev} hasNext={!!list.data.next_cursor} onPrev={pager.prev} onNext={() => pager.next(list.data!.next_cursor!)} />
        </>
      )}
    </div>
  );
}

