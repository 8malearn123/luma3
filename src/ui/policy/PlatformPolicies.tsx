'use client';

import { useState } from 'react';
import { Gavel, Inbox, Lightbulb, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { PageHeader, Pager, Tabs } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { ActionBadge, DecisionStatus, fromLocalInput, IncidentStatus } from './labels';
import { RulesEditor } from './RulesPanel';
import { AppealsInbox } from './AppealsPanel';
import { useStepUp } from './StepUp';
import { useCursorStack } from './paging';

const BASE = '/api/v1/platform/policies';
const TZ = 'Asia/Riyadh';
type Tab = 'escalations' | 'decisions' | 'rules' | 'appeals';
type Escalation = {
  id: string; tenant_name: string; type: string; status: string; description: string; occurred_at: string; escalated_to_platform_at: string;
  escalation_status: string; escalation_note: string | null; customer_user_id: string | null; customer_name: string | null; evidence_count: number;
  suggestions: Array<{ rule_id: string; key: string; suggested_action: string; matched_incidents: number; is_experimental: boolean }>;
};
type Decision = { id: string; action: string; status: string; reason: string; customer_name: string | null; customer_user_id: string; reviewer_name: string | null; effective_at: string; expires_at: string | null; review_flagged_at: string | null; is_experimental: boolean };
type Prefill = { customerUserId?: string; customerName?: string | null; incidentId?: string; action?: string; ruleId?: string; experimental?: boolean; supersedesId?: string };

export function PlatformPolicies({ isOwner }: { isOwner: boolean }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('escalations');
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  return (
    <div className="mx-auto w-full max-w-6xl p-3 sm:p-6">
      <PageHeader title={t('platform_policy.title')} subtitle={t('platform_policy.subtitle')} actions={<Button icon={<Gavel className="size-4" />} onClick={() => setPrefill({})}>{t('platform_policy.decide')}</Button>} />
      <Tabs value={tab} onChange={setTab} items={(['escalations', 'decisions', 'rules', 'appeals'] as const).map((v) => ({ value: v, label: t(`platform_policy.tabs.${v}`) }))} />
      {tab === 'escalations' ? <Escalations onDecide={setPrefill} /> : null}
      {tab === 'decisions' ? <Decisions isOwner={isOwner} onSupersede={setPrefill} /> : null}
      {tab === 'rules' ? <RulesEditor endpoint={`${BASE}/rules`} queryKey={['platform-rules']} writable /> : null}
      {tab === 'appeals' ? <AppealsInbox endpoint={`${BASE}/appeals`} queryKey={['platform-appeals']} writable tz={TZ} /> : null}
      {prefill ? <NewPlatformDecision prefill={prefill} isOwner={isOwner} onClose={() => setPrefill(null)} onDone={() => { setPrefill(null); setTab('decisions'); }} /> : null}
    </div>
  );
}

function Escalations({ onDecide }: { onDecide: (p: Prefill) => void }) {
  const { t, locale, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [status, setStatus] = useState('pending');
  const pager = useCursorStack(status);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const params = new URLSearchParams({ status });
  if (pager.cursor) params.set('cursor', pager.cursor);
  const q = useApiQuery<{ items: Escalation[]; next_cursor: string | null }>(['platform-escalations', params.toString()], `${BASE}/escalations?${params}`);
  async function dismiss(id: string) {
    setErr(null);
    try {
      await stepUp(() => api(`${BASE}/escalations/${id}/dismiss`, { body: { note } }));
      setDismissing(null); setNote('');
      await qc.invalidateQueries({ queryKey: ['platform-escalations'] });
    } catch (e) { if (!(e instanceof ApiError && e.message === 'cancelled')) setErr(e); }
  }
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('fields.status')} className="max-w-48">{(p) => (
        <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>
          {['pending', 'decided', 'dismissed'].map((s) => <option key={s} value={s}>{t(`policy.escalation.${s}`)}</option>)}<option value="all">{t('policy.statuses.all')}</option>
        </Select>
      )}</Field>
      <FormErrorSummary message={err ? msg(err) : null} />
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.items.length ? <EmptyState title={t('platform_policy.empty')} icon={<Inbox className="size-8" aria-hidden />} /> : (
        <>
          <ul className="flex flex-col gap-3">
            {q.data.items.map((e) => (
              <li key={e.id} className="rounded-xl border border-line bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t(`policy.types.${e.type}`)}</span><IncidentStatus status={e.status} /><Badge tone="info">{t(`policy.escalation.${e.escalation_status}`)}</Badge>
                  <span className="text-xs text-ink-muted">{t('platform_policy.escalated_at')}: {formatDateTime(e.escalated_to_platform_at, { locale, tz: TZ, timeFormat })}</span>
                </div>
                <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-3">
                  <div><dt className="text-xs text-ink-muted">{t('platform_policy.business')}</dt><dd>{e.tenant_name}</dd></div>
                  <div><dt className="text-xs text-ink-muted">{t('platform_policy.customer')}</dt><dd>{e.customer_name ?? '—'}</dd></div>
                  <div><dt className="text-xs text-ink-muted">{t('policy.occurred_at')}</dt><dd>{formatDateTime(e.occurred_at, { locale, tz: TZ, timeFormat })}</dd></div>
                </dl>
                <p className="mt-2 whitespace-pre-wrap text-sm">{e.description}</p>
                {e.escalation_note ? <p className="mt-1 text-xs text-ink-muted">{t('policy.escalation_note')}: {e.escalation_note}</p> : null}
                <p className="text-xs text-ink-muted">{t('platform_policy.evidence_count', { n: e.evidence_count })}</p>
                {e.suggestions.length ? (
                  <div className="mt-2 rounded-lg bg-warn-bg/60 p-2 text-sm">
                    <p className="flex items-center gap-1 font-medium"><Lightbulb className="size-4" aria-hidden />{t('policy.suggestions')}</p>
                    <p className="text-xs text-ink-muted">{t('policy.suggestions_note')}</p>
                    {e.suggestions.map((s) => <div key={s.rule_id} className="mt-1 flex flex-wrap items-center gap-2"><ActionBadge action={s.suggested_action} /><span dir="ltr">{s.key}</span><span className="text-ink-muted">{t('policy.matched', { n: s.matched_incidents })}</span></div>)}
                  </div>
                ) : null}
                {e.escalation_status === 'pending' && e.customer_user_id ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" icon={<Gavel className="size-4" />} onClick={() => onDecide({ customerUserId: e.customer_user_id!, customerName: e.customer_name, incidentId: e.id, ...(e.suggestions[0] ? { action: e.suggestions[0].suggested_action, ruleId: e.suggestions[0].rule_id, experimental: e.suggestions[0].is_experimental } : {}) })}>{t('platform_policy.decide')}</Button>
                    <Button size="sm" variant="outline" icon={<XCircle className="size-4" />} onClick={() => setDismissing(dismissing === e.id ? null : e.id)}>{t('platform_policy.dismiss')}</Button>
                  </div>
                ) : null}
                {dismissing === e.id ? (
                  <form className="mt-2 flex flex-col gap-2" onSubmit={(ev) => { ev.preventDefault(); void dismiss(e.id); }}>
                    <Field label={t('policy.note')} required>{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(ev) => setNote(ev.target.value)} />}</Field>
                    <div><Button type="submit" size="sm" disabled={note.trim().length < 3}>{t('platform_policy.dismiss')}</Button></div>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          <Pager hasPrev={pager.hasPrev} hasNext={!!q.data.next_cursor} onPrev={pager.prev} onNext={() => pager.next(q.data!.next_cursor!)} />
        </>
      )}
    </div>
  );
}

function Decisions({ isOwner, onSupersede }: { isOwner: boolean; onSupersede: (p: Prefill) => void }) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [status, setStatus] = useState('active');
  const [due, setDue] = useState(false);
  const pager = useCursorStack(`${status}|${due}`);
  const [ending, setEnding] = useState<{ id: string; kind: 'revoke' | 'expire' } | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const params = new URLSearchParams({ status, limit: '25' });
  if (due) params.set('review_due', '1');
  if (pager.cursor) params.set('cursor', pager.cursor);
  const q = useApiQuery<{ items: Decision[]; next_cursor: string | null }>(['platform-decisions', params.toString()], `${BASE}/decisions?${params}`);
  async function end() {
    if (!ending) return;
    setErr(null);
    try {
      await stepUp(() => api(`${BASE}/decisions/${ending.id}/end`, { body: { kind: ending.kind, reason } }));
      setEnding(null); setReason('');
      await qc.invalidateQueries({ queryKey: ['platform-decisions'] });
    } catch (e) { if (!(e instanceof ApiError && e.message === 'cancelled')) setErr(e); }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('fields.status')} className="min-w-40">{(p) => <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>{['active', 'superseded', 'revoked', 'expired', 'all'].map((s) => <option key={s} value={s}>{t(`policy.decisions.status.${s}`)}</option>)}</Select>}</Field>
        <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-luma-700" checked={due} onChange={(e) => setDue(e.target.checked)} />{t('policy.decisions.review_due')}</label>
      </div>
      <FormErrorSummary message={err ? msg(err) : null} />
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.items.length ? <EmptyState title={t('policy.decisions.none')} /> : (
        <>
          <ul className="flex flex-col gap-2">
            {q.data.items.map((d) => (
              <li key={d.id} className="rounded-xl border border-line bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.customer_name ?? d.customer_user_id}</span><ActionBadge action={d.action} /><DecisionStatus status={d.status} />
                  {d.is_experimental ? <Badge tone="warn">{t('policy.decisions.experimental')}</Badge> : null}
                  {d.review_flagged_at && d.status === 'active' ? <Badge tone="danger">{t('policy.decisions.review_due')}</Badge> : null}
                  <span className="text-xs text-ink-muted">{formatDateTime(d.effective_at, { locale, tz: TZ, time: false })}{d.expires_at ? ` → ${formatDateTime(d.expires_at, { locale, tz: TZ, time: false })}` : ''}</span>
                </div>
                <p className="mt-1 text-ink-muted">{d.reason}</p>
                {d.status === 'active' && (d.action !== 'suspend_account' || isOwner) ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" onClick={() => onSupersede({ customerUserId: d.customer_user_id, customerName: d.customer_name, supersedesId: d.id, action: d.action })}>{t('policy.decisions.supersede')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEnding({ id: d.id, kind: 'revoke' })}>{t('policy.decisions.revoke')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEnding({ id: d.id, kind: 'expire' })}>{t('policy.decisions.expire')}</Button>
                  </div>
                ) : null}
                {ending?.id === d.id ? (
                  <form className="mt-2 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void end(); }}>
                    <Field label={t('policy.decisions.end_reason')} required>{(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
                    <div><Button type="submit" size="sm" variant="danger" disabled={reason.trim().length < 3}>{t(ending.kind === 'revoke' ? 'policy.decisions.revoke' : 'policy.decisions.expire')}</Button></div>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          <Pager hasPrev={pager.hasPrev} hasNext={!!q.data.next_cursor} onPrev={pager.prev} onNext={() => pager.next(q.data!.next_cursor!)} />
        </>
      )}
    </div>
  );
}

function NewPlatformDecision({ prefill, isOwner, onClose, onDone }: { prefill: Prefill; isOwner: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const [userId, setUserId] = useState(prefill.customerUserId ?? '');
  const [action, setAction] = useState(prefill.action ?? 'require_deposit');
  const [reason, setReason] = useState('');
  const [exAr, setExAr] = useState('');
  const [exEn, setExEn] = useState('');
  const [expires, setExpires] = useState('');
  const [review, setReview] = useState('');
  const [experimental, setExperimental] = useState(prefill.experimental ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const actions = ['require_deposit', 'require_full_payment', 'manual_approval', 'default', ...(isOwner ? ['suspend_account'] : [])];
  async function submit() {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api(`${BASE}/decisions`, { body: {
        customer_user_id: userId.trim(), action, reason, customer_explanation_ar: exAr || null, customer_explanation_en: exEn || null,
        incident_id: prefill.incidentId ?? null, supersedes_id: prefill.supersedesId ?? null, rule_id: prefill.ruleId ?? null, is_experimental: experimental,
        expires_at: fromLocalInput(expires) ?? null, review_at: fromLocalInput(review) ?? null,
      } }));
      await Promise.all([qc.invalidateQueries({ queryKey: ['platform-decisions'] }), qc.invalidateQueries({ queryKey: ['platform-escalations'] })]);
      toast({ tone: 'ok', text: t('policy.decisions.created') });
      onDone();
    } catch (e) { if (!(e instanceof ApiError && e.message === 'cancelled')) setErr(e); } finally { setBusy(false); }
  }
  const issues = err instanceof ApiError && err.code === 'validation_failed' ? (err.details?.issues as Array<{ path: string; message: string }>) : undefined;
  return (
    <Drawer open onClose={onClose} title={prefill.supersedesId ? t('policy.decisions.supersede') : t('platform_policy.decide')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} disabled={!userId.trim() || reason.trim().length < 5} onClick={submit}>{t('actions.save')}</Button></>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
        {prefill.ruleId ? <Alert tone="warn">{t('policy.suggestions_note')}</Alert> : null}
        {prefill.customerUserId ? <p className="text-sm"><span className="text-ink-muted">{t('platform_policy.customer')}: </span>{prefill.customerName ?? prefill.customerUserId}</p>
          : <Field label={t('platform_policy.customer_user_id')} required>{(p) => <Input {...p} dir="ltr" value={userId} onChange={(e) => setUserId(e.target.value)} />}</Field>}
        <Field label={t('policy.decisions.action')} hint={isOwner ? undefined : t('platform_policy.suspend_owner_only')} required>{(p) => <Select {...p} value={action} onChange={(e) => setAction(e.target.value)}>{actions.map((a) => <option key={a} value={a}>{t(`policy.actions_labels.${a}`)}</option>)}</Select>}</Field>
        <Field label={t('policy.decisions.reason')} hint={t('policy.decisions.reason_hint')} required>{(p) => <Textarea {...p} rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Field label={t('policy.decisions.explanation_ar')} hint={t('policy.decisions.explanation_hint')}>{(p) => <Textarea {...p} dir="rtl" rows={2} maxLength={600} value={exAr} onChange={(e) => setExAr(e.target.value)} />}</Field>
        <Field label={t('policy.decisions.explanation_en')}>{(p) => <Textarea {...p} dir="ltr" rows={2} maxLength={600} value={exEn} onChange={(e) => setExEn(e.target.value)} />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('policy.decisions.expires_at')}>{(p) => <Input {...p} type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />}</Field>
          <Field label={t('policy.decisions.review_at')}>{(p) => <Input {...p} type="datetime-local" value={review} onChange={(e) => setReview(e.target.value)} />}</Field>
        </div>
        <Checkbox label={t('policy.decisions.experimental')} description={t('policy.decisions.experimental_hint')} checked={experimental} onChange={setExperimental} />
      </form>
    </Drawer>
  );
}
