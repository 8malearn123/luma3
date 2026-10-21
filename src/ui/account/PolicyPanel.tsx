'use client';

import { useState } from 'react';
import { MessageSquare, ShieldCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDate } from '@/shared/format';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Textarea } from '../components/form';
import { Card } from '../components/layout';
import { Dialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { AppealStatus } from '../policy/labels';

type Decision = { id: string; scope: string; action: string; status: string; effective_at: string; expires_at: string | null; customer_explanation_ar: string | null; customer_explanation_en: string | null; tenant_name: string | null; can_appeal: boolean; appeal_open: boolean };
type Incident = { id: string; type: string; status: string; occurred_at: string; tenant_name: string; booking_number: string | null; can_appeal: boolean; appeal_open: boolean };
type Appeal = { id: string; status: string; message: string; resolution_note: string | null; created_at: string; decision_action: string | null; incident_type: string | null; tenant_name: string | null; review_scope: string };

/** Only the effect and the customer-facing explanation: never reasons, evidence, employees or other customers. */
export function PolicyPanel() {
  const { t, locale, pick } = useI18n();
  const q = useApiQuery<{ decisions: Decision[]; incidents: Incident[] }>(['account-policy'], '/api/v1/account/policy');
  const appeals = useApiQuery<Appeal[]>(['account-appeals'], '/api/v1/account/appeals');
  const [target, setTarget] = useState<{ decision_id?: string; incident_id?: string; label: string } | null>(null);
  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('account.policy.decisions')}>
        {d.decisions.length ? (
          <ul className="flex flex-col gap-3">
            {d.decisions.map((x) => (
              <li key={x.id} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={x.status === 'active' ? 'brand' : 'neutral'}>{t(`policy.actions_labels.${x.action}`)}</Badge>
                  <span className="text-sm font-medium">{x.tenant_name ?? t('account.policy.luma_scope')}</span>
                  <Badge>{t(`account.policy.status.${x.status}`)}</Badge>
                  <span className="text-xs text-ink-muted">{t('account.policy.since', { date: formatDate(x.effective_at, { locale }) })}{x.expires_at ? ` · ${t('account.policy.until', { date: formatDate(x.expires_at, { locale }) })}` : ''}</span>
                </div>
                {pick(x.customer_explanation_ar, x.customer_explanation_en) ? <p className="mt-2 text-sm">{pick(x.customer_explanation_ar, x.customer_explanation_en)}</p> : null}
                {x.appeal_open ? <Badge tone="info" className="mt-2">{t('account.policy.appeal_open')}</Badge> : x.can_appeal ? (
                  <Button size="sm" variant="outline" className="mt-2" icon={<MessageSquare className="size-4" />} onClick={() => setTarget({ decision_id: x.id, label: t(`policy.actions_labels.${x.action}`) })}>{t('account.policy.appeal')}</Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <p className="flex items-center gap-2 text-sm text-ink-muted"><ShieldCheck className="size-4 text-ok" aria-hidden />{t('account.policy.none')}</p>}
      </Card>
      <Card title={t('account.policy.incidents')}>
        {d.incidents.length ? (
          <ul className="flex flex-col gap-2">
            {d.incidents.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{t(`policy.types.${x.type}`)}</span>
                <span>{x.tenant_name}</span>
                <span className="text-xs text-ink-muted">{formatDate(x.occurred_at, { locale })}{x.booking_number ? ` · ${x.booking_number}` : ''}</span>
                {x.appeal_open ? <Badge tone="info">{t('account.policy.appeal_open')}</Badge> : x.can_appeal ? (
                  <Button size="sm" variant="ghost" icon={<MessageSquare className="size-4" />} onClick={() => setTarget({ incident_id: x.id, label: t(`policy.types.${x.type}`) })}>{t('account.policy.appeal')}</Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-muted">{t('account.policy.none_incidents')}</p>}
      </Card>
      <Card title={t('account.policy.appeals')}>
        {appeals.isLoading ? <LoadingState rows={2} /> : appeals.error ? <ErrorState error={appeals.error} onRetry={() => appeals.refetch()} /> : appeals.data?.length ? (
          <ul className="flex flex-col gap-3">
            {appeals.data.map((a) => (
              <li key={a.id} className="border-b border-line pb-3 text-sm last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <AppealStatus status={a.status} />
                  <span>{a.decision_action ? t(`policy.actions_labels.${a.decision_action}`) : a.incident_type ? t(`policy.types.${a.incident_type}`) : ''}</span>
                  <span className="text-ink-muted">{a.tenant_name ?? t('account.policy.luma_scope')}</span>
                  <span className="text-xs text-ink-muted">{formatDate(a.created_at, { locale })}</span>
                </div>
                <p className="mt-1 text-ink-muted">{a.message}</p>
                {a.resolution_note ? <p className="mt-1"><span className="text-xs text-luma-800">{t('account.policy.reply')}: </span>{a.resolution_note}</p> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-muted">{t('account.policy.no_appeals')}</p>}
      </Card>
      {target ? <AppealDialog target={target} onClose={() => setTarget(null)} /> : null}
    </div>
  );
}

function AppealDialog({ target, onClose }: { target: { decision_id?: string; incident_id?: string; label: string }; onClose: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function submit() {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/account/appeals', { body: { ...(target.decision_id ? { decision_id: target.decision_id } : { incident_id: target.incident_id }), message } });
      await Promise.all([qc.invalidateQueries({ queryKey: ['account-policy'] }), qc.invalidateQueries({ queryKey: ['account-appeals'] })]);
      toast({ tone: 'ok', text: t('account.policy.appeal_sent') });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={`${t('account.policy.appeal_title')}: ${target.label}`}
      footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} disabled={message.trim().length < 10} onClick={submit}>{t('actions.submit')}</Button></>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (message.trim().length >= 10) void submit(); }}>
        <Alert tone="info">{t('account.policy.appeal_hint')}</Alert>
        <FormErrorSummary message={err ? msg(err) : null} />
        <Field label={t('account.policy.appeal_message')} required>{(p) => <Textarea {...p} rows={4} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
      </form>
    </Dialog>
  );
}
