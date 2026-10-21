'use client';

import { useState } from 'react';
import { Gavel, RotateCcw, TimerOff, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime, tzLabel } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Card } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { CustomerPicker, AuditTrail } from './IncidentDrawers';
import { ActionBadge, DecisionStatus, fromLocalInput } from './labels';
import { useStepUp } from './StepUp';

export type DecisionPrefill = {
  tenantCustomerId?: string; customerName?: string; incidentId?: string; action?: string; ruleId?: string; experimental?: boolean;
  supersedesId?: string; expiresAt?: string | null;
};

const ACTIONS = ['require_deposit', 'require_full_payment', 'manual_approval', 'default'] as const;

export function NewDecisionDrawer({ prefill, onClose, onCreated }: { prefill: DecisionPrefill; onClose: () => void; onCreated: (id: string) => void }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(prefill.tenantCustomerId ? { id: prefill.tenantCustomerId, name: prefill.customerName ?? '—' } : null);
  const [action, setAction] = useState<string>(prefill.action ?? 'require_deposit');
  const [reason, setReason] = useState('');
  const [exAr, setExAr] = useState('');
  const [exEn, setExEn] = useState('');
  const [expires, setExpires] = useState('');
  const [review, setReview] = useState('');
  const [experimental, setExperimental] = useState(prefill.experimental ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useUnsavedChangesWarning(!!(reason || exAr || exEn));

  async function submit() {
    if (!customer) return;
    setBusy(true); setErr(null);
    try {
      const body = {
        tenant_customer_id: customer.id, action, reason,
        customer_explanation_ar: exAr || null, customer_explanation_en: exEn || null,
        evidence_refs: prefill.incidentId ? [{ type: 'incident', id: prefill.incidentId }] : [],
        expires_at: fromLocalInput(expires) ?? null, review_at: fromLocalInput(review) ?? null,
        supersedes_id: prefill.supersedesId ?? null, rule_id: prefill.ruleId ?? null, is_experimental: experimental,
      };
      const r = await stepUp(() => api<{ id: string }>(access.api('/policies/decisions'), { body }));
      await qc.invalidateQueries({ queryKey: ['decisions', access.slug] });
      toast({ tone: 'ok', text: t('policy.decisions.created') });
      onCreated(r.id);
    } catch (e) { if (!(e instanceof ApiError && e.message === 'cancelled')) setErr(e); } finally { setBusy(false); }
  }
  const issues = err instanceof ApiError && err.code === 'validation_failed' ? (err.details?.issues as Array<{ path: string; message: string }>) : undefined;
  return (
    <Drawer open onClose={onClose} title={prefill.supersedesId ? t('policy.decisions.supersede') : t('policy.decisions.new')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button icon={<Gavel className="size-4" />} loading={busy} disabled={!customer || reason.trim().length < 5} onClick={submit}>{t('actions.save')}</Button></>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
        {prefill.supersedesId ? <Alert tone="info">{t('policy.decisions.supersedes')}</Alert> : null}
        {prefill.ruleId ? <Alert tone="warn">{t('policy.suggestions_note')}</Alert> : null}
        {prefill.tenantCustomerId ? (
          <p className="text-sm"><span className="text-ink-muted">{t('policy.decisions.customer')}: </span>{customer?.name}</p>
        ) : <CustomerPicker label={t('policy.decisions.customer')} value={customer} onChange={setCustomer} />}
        <Field label={t('policy.decisions.action')} required>{(p) => <Select {...p} value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map((a) => <option key={a} value={a}>{t(`policy.actions_labels.${a}`)}</option>)}</Select>}</Field>
        <Field label={t('policy.decisions.reason')} hint={t('policy.decisions.reason_hint')} required>{(p) => <Textarea {...p} rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Field label={t('policy.decisions.explanation_ar')} hint={t('policy.decisions.explanation_hint')}>{(p) => <Textarea {...p} dir="rtl" lang="ar" rows={2} maxLength={600} value={exAr} onChange={(e) => setExAr(e.target.value)} />}</Field>
        <Field label={t('policy.decisions.explanation_en')}>{(p) => <Textarea {...p} dir="ltr" lang="en" rows={2} maxLength={600} value={exEn} onChange={(e) => setExEn(e.target.value)} />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('policy.decisions.expires_at')}>{(p) => <Input {...p} type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />}</Field>
          <Field label={t('policy.decisions.review_at')}>{(p) => <Input {...p} type="datetime-local" value={review} onChange={(e) => setReview(e.target.value)} />}</Field>
        </div>
        <p className="text-xs text-ink-muted">{t('time.tz_note', { tz: tzLabel(Intl.DateTimeFormat().resolvedOptions().timeZone, locale) })}</p>
        <Checkbox label={t('policy.decisions.experimental')} description={t('policy.decisions.experimental_hint')} checked={experimental} onChange={setExperimental} />
      </form>
    </Drawer>
  );
}

type DecisionDetail = {
  id: string; action: string; status: string; reason: string; customer_name: string; reviewer_name: string | null; tenant_customer_id: string;
  customer_explanation_ar: string | null; customer_explanation_en: string | null; effective_at: string; expires_at: string | null; review_at: string | null; review_flagged_at: string | null;
  ended_at: string | null; end_reason: string | null; supersedes_id: string | null; is_experimental: boolean; evidence_refs: Array<{ type: string; id?: string; note?: string }>;
  history: Array<{ id: string; action: string; status: string; effective_at: string; ended_at: string | null }>;
};

export function DecisionDrawer({ id, onClose, onSupersede }: { id: string; onClose: () => void; onSupersede: (p: DecisionPrefill) => void }) {
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useApiQuery<DecisionDetail>(['decision', access.slug, id], access.api(`/policies/decisions/${id}`));
  const [ending, setEnding] = useState<null | 'revoke' | 'expire'>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const fmt = (v: string) => formatDateTime(v, { locale, tz: access.timezone, timeFormat });
  async function end() {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api(access.api(`/policies/decisions/${id}/end`), { body: { kind: ending, reason } }));
      await Promise.all([qc.invalidateQueries({ queryKey: ['decision', access.slug, id] }), qc.invalidateQueries({ queryKey: ['decisions', access.slug] }), qc.invalidateQueries({ queryKey: ['audit', access.slug, id] })]);
      setEnding(null); setReason('');
    } catch (e) { if (!(e instanceof ApiError && e.message === 'cancelled')) setErr(e); } finally { setBusy(false); }
  }
  const d = q.data;
  const writable = !access.readOnly && d?.status === 'active';
  return (
    <Drawer open onClose={onClose} wide title={d ? `${t(`policy.actions_labels.${d.action}`)} — ${d.customer_name}` : t('states.loading')}>
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <LoadingState rows={5} /> : (
        <div className="flex flex-col gap-4">
          <FormErrorSummary message={err ? msg(err) : null} />
          <div className="flex flex-wrap items-center gap-2">
            <ActionBadge action={d.action} /><DecisionStatus status={d.status} />
            {d.is_experimental ? <Badge tone="warn">{t('policy.decisions.experimental')}</Badge> : null}
            {d.review_flagged_at && d.status === 'active' ? <Badge tone="danger">{t('policy.decisions.review_due')}</Badge> : null}
          </div>
          <Card>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="sm:col-span-2"><dt className="text-xs text-ink-muted">{t('policy.decisions.reason')}</dt><dd className="whitespace-pre-wrap">{d.reason}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('policy.decisions.explanation_ar')}</dt><dd dir="rtl">{d.customer_explanation_ar ?? '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('policy.decisions.explanation_en')}</dt><dd dir="ltr">{d.customer_explanation_en ?? '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('policy.decisions.effective_at')}</dt><dd>{fmt(d.effective_at)}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('policy.decisions.expires_at')}</dt><dd>{d.expires_at ? fmt(d.expires_at) : '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('policy.decisions.review_at')}</dt><dd>{d.review_at ? fmt(d.review_at) : '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('policy.decisions.reviewer')}</dt><dd>{d.reviewer_name ?? '—'}</dd></div>
              {d.ended_at ? <div className="sm:col-span-2"><dt className="text-xs text-ink-muted">{t('policy.decisions.end_reason')}</dt><dd>{fmt(d.ended_at)} — {d.end_reason}</dd></div> : null}
              {d.evidence_refs.length ? <div className="sm:col-span-2"><dt className="text-xs text-ink-muted">{t('policy.evidence')}</dt><dd>{d.evidence_refs.map((r, i) => <span key={i} className="me-2">{r.type === 'note' ? r.note : `${t(r.type === 'incident' ? 'policy.decisions.evidence_incidents' : 'policy.evidence')}`}</span>)}</dd></div> : null}
            </dl>
          </Card>
          {writable ? (
            <Card>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" icon={<RotateCcw className="size-4" />} onClick={() => onSupersede({ tenantCustomerId: d.tenant_customer_id, customerName: d.customer_name, supersedesId: d.id, action: d.action })}>{t('policy.decisions.supersede')}</Button>
                <Button variant="outline" icon={<XCircle className="size-4" />} onClick={() => setEnding('revoke')}>{t('policy.decisions.revoke')}</Button>
                <Button variant="outline" icon={<TimerOff className="size-4" />} onClick={() => setEnding('expire')}>{t('policy.decisions.expire')}</Button>
              </div>
              {ending ? (
                <form className="mt-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void end(); }}>
                  <Field label={t('policy.decisions.end_reason')} required>{(p) => <Textarea {...p} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
                  <div><Button type="submit" variant="danger" loading={busy} disabled={reason.trim().length < 3}>{t(ending === 'revoke' ? 'policy.decisions.revoke' : 'policy.decisions.expire')}</Button></div>
                </form>
              ) : null}
            </Card>
          ) : null}
          <Card title={t('policy.history')}>
            <ol className="flex flex-col gap-1 text-sm">
              {d.history.map((h) => (
                <li key={h.id} className={`flex flex-wrap items-center gap-2 ${h.id === d.id ? 'font-medium' : ''}`}>
                  <ActionBadge action={h.action} /><DecisionStatus status={h.status} /><span className="text-xs text-ink-muted">{fmt(h.effective_at)}</span>
                </li>
              ))}
            </ol>
          </Card>
          <AuditTrail targetType="policy_decision" targetId={id} />
        </div>
      )}
    </Drawer>
  );
}

