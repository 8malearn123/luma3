'use client';

import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Select, Textarea } from '../components/form';
import { Pager } from '../components/layout';
import { ActionBadge, AppealStatus } from './labels';
import { useStepUp } from './StepUp';
import { useCursorStack } from './paging';

type Appeal = {
  id: string; status: string; message: string; resolution_note: string | null; created_at: string; resolved_at: string | null;
  decision_id: string | null; incident_id: string | null; customer_name: string | null;
  decision_action?: string | null; decision_status?: string | null; decision_reason?: string | null; incident_type?: string | null; incident_status?: string | null;
};

export function AppealsPanel() {
  const access = useAccess();
  return <AppealsInbox endpoint={access.api('/policies/appeals')} queryKey={['appeals', access.slug]} writable={!access.readOnly} tz={access.timezone} />;
}

/** Appeals inbox shared by the tenant dashboard and the platform page. */
export function AppealsInbox({ endpoint, queryKey, writable, tz }: { endpoint: string; queryKey: string[]; writable: boolean; tz: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState('open');
  const pager = useCursorStack(status);
  const params = new URLSearchParams({ status, limit: '20' });
  if (pager.cursor) params.set('cursor', pager.cursor);
  const q = useApiQuery<{ items: Appeal[]; next_cursor: string | null }>([...queryKey, params.toString()], `${endpoint}?${params}`);
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('fields.status')} className="max-w-48">{(p) => (
        <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>
          {['open', 'submitted', 'under_review', 'accepted', 'rejected', 'all'].map((s) => <option key={s} value={s}>{s === 'open' ? t('policy.appeals.open') : s === 'all' ? t('policy.appeals.all') : t(`policy.appeals.${s}`)}</option>)}
        </Select>
      )}</Field>
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.items.length ? <EmptyState title={t('policy.appeals.none')} icon={<MessageSquare className="size-8" aria-hidden />} /> : (
        <>
          <ul className="flex flex-col gap-3">{q.data.items.map((a) => <AppealCard key={a.id} a={a} endpoint={endpoint} queryKey={queryKey} writable={writable} tz={tz} />)}</ul>
          <Pager hasPrev={pager.hasPrev} hasNext={!!q.data.next_cursor} onPrev={pager.prev} onNext={() => pager.next(q.data!.next_cursor!)} />
        </>
      )}
    </div>
  );
}

function AppealCard({ a, endpoint, queryKey, writable, tz }: { a: Appeal; endpoint: string; queryKey: string[]; writable: boolean; tz: string }) {
  const { t, locale, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [outcome, setOutcome] = useState('accepted');
  const [note, setNote] = useState('');
  const [corrected, setCorrected] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const open = a.status === 'submitted' || a.status === 'under_review';
  async function resolve() {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api(`${endpoint}/${a.id}/resolve`, { body: { outcome, resolution_note: note, ...(outcome === 'accepted' && corrected ? { corrected_action: corrected } : {}) } }));
      await qc.invalidateQueries({ queryKey });
      setNote('');
    } catch (e) { if (!(e instanceof ApiError && e.message === 'cancelled')) setErr(e); } finally { setBusy(false); }
  }
  return (
    <li className="rounded-xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <AppealStatus status={a.status} />
        <span className="font-medium">{a.customer_name ?? '—'}</span>
        {a.decision_action ? <><span className="text-sm text-ink-muted">{t('policy.appeals.item_decision', { action: '' })}</span><ActionBadge action={a.decision_action} /></> : null}
        {a.incident_type ? <span className="text-sm">{t('policy.appeals.item_incident', { type: t(`policy.types.${a.incident_type}`) })}</span> : null}
        <span className="text-xs text-ink-muted">{formatDateTime(a.created_at, { locale, tz, timeFormat })}</span>
      </div>
      {a.decision_reason ? <p className="mt-1 text-xs text-ink-muted">{t('policy.decisions.reason')}: {a.decision_reason}</p> : null}
      <p className="mt-2 whitespace-pre-wrap rounded-lg bg-luma-50 p-2 text-sm"><span className="sr-only">{t('policy.appeals.message')}: </span>{a.message}</p>
      {a.resolution_note ? <p className="mt-2 text-sm"><span className="text-xs text-ink-muted">{t('policy.appeals.resolution_note')}: </span>{a.resolution_note}</p> : null}
      <FormErrorSummary message={err ? msg(err) : null} />
      {open && writable ? (
        <form className="mt-3 grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void resolve(); }}>
          <Field label={t('policy.appeals.outcome')}>{(p) => (
            <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="accepted">{t('policy.appeals.accepted')}</option><option value="rejected">{t('policy.appeals.rejected')}</option>
              {a.status === 'submitted' ? <option value="under_review">{t('policy.appeals.under_review')}</option> : null}
            </Select>
          )}</Field>
          {outcome === 'accepted' && a.decision_id && a.decision_status === 'active' ? (
            <Field label={t('policy.appeals.corrected_action')}>{(p) => (
              <Select {...p} value={corrected} onChange={(e) => setCorrected(e.target.value)}>
                <option value="">{t('policy.appeals.revoke_instead')}</option>
                {['default', 'manual_approval', 'require_deposit', 'require_full_payment'].filter((x) => x !== a.decision_action).map((x) => <option key={x} value={x}>{t(`policy.actions_labels.${x}`)}</option>)}
              </Select>
            )}</Field>
          ) : null}
          <Field label={t('policy.appeals.resolution_note')} hint={t('policy.appeals.resolution_hint')} required className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          <div className="sm:col-span-2"><Button type="submit" loading={busy} disabled={note.trim().length < 3}>{t('policy.appeals.resolve')}</Button></div>
        </form>
      ) : null}
    </li>
  );
}
