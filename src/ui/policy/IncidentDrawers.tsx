'use client';

import { useRef, useState } from 'react';
import { Gavel, ImagePlus, Lightbulb, Send, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiQuery, useDebounced, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button, IconButton } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState, Spinner } from '../components/feedback';
import { Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Card } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { ActionBadge, fromLocalInput, IncidentStatus } from './labels';
import { useStepUp } from './StepUp';
import type { DecisionPrefill } from './DecisionDrawers';

const TYPES = ['no_show', 'late_cancellation', 'payment_dispute', 'conduct', 'other'] as const;

/** Searches this business's customers only (needs customers.view). */
export function CustomerPicker({ value, onChange, label }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void; label: string }) {
  const { t } = useI18n();
  const access = useAccess();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const res = useApiQuery<{ items: Array<{ id: string; display_name: string; phone: string | null }> }>(['customer-pick', access.slug, dq], dq.length >= 2 ? access.api(`/customers?q=${encodeURIComponent(dq)}&limit=8`) : null);
  if (value) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center justify-between rounded-lg border border-line bg-luma-50 px-3 py-2 text-sm">
          <span>{value.name}</span>
          <IconButton label={t('actions.clear')} onClick={() => onChange(null)}><Trash2 className="size-4" /></IconButton>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Field label={label}>{(p) => <Input {...p} type="search" value={q} placeholder={t('policy.pick_customer')} onChange={(e) => setQ(e.target.value)} />}</Field>
      {res.isFetching ? <Spinner /> : null}
      {res.data?.items.length ? (
        <ul className="rounded-lg border border-line bg-white" role="listbox" aria-label={label}>
          {res.data.items.map((c) => (
            <li key={c.id}>
              <button type="button" role="option" aria-selected={false} className="flex w-full justify-between px-3 py-2 text-start text-sm hover:bg-luma-50" onClick={() => { onChange({ id: c.id, name: c.display_name }); setQ(''); }}>
                <span>{c.display_name}</span><span dir="ltr" className="text-ink-muted">{c.phone ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function NewIncidentDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const [bookingId, setBookingId] = useState('');
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [type, setType] = useState<(typeof TYPES)[number]>('no_show');
  const [description, setDescription] = useState('');
  const [occurred, setOccurred] = useState('');
  const [evidence, setEvidence] = useState<Array<{ asset_id?: string; note?: string; preview?: string }>>([]);
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useUnsavedChangesWarning(!!(description || bookingId || evidence.length));
  const needsBooking = type === 'no_show' || type === 'late_cancellation';

  async function upload(file: File) {
    setUploading(true); setErr(null);
    try {
      const form = new FormData();
      form.set('file', file); form.set('purpose', 'evidence');
      const r = await api<{ id: string; url: string }>(access.api('/assets'), { form });
      setEvidence((e) => [...e, { asset_id: r.id, preview: r.url }]);
    } catch (e) { setErr(e); } finally { setUploading(false); }
  }
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id: string }>(access.api('/policies/incidents'), { body: {
        type, description, booking_id: bookingId.trim() || null, tenant_customer_id: customer?.id ?? null,
        occurred_at: fromLocalInput(occurred), evidence: evidence.map(({ asset_id, note: n }) => ({ ...(asset_id ? { asset_id } : {}), ...(n ? { note: n } : {}) })),
      } });
      await qc.invalidateQueries({ queryKey: ['incidents', access.slug] });
      toast({ tone: 'ok', text: t('policy.submitted') });
      onCreated(r.id);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const issues = err instanceof ApiError && err.code === 'validation_failed' ? (err.details?.issues as Array<{ path: string; message: string }>) : undefined;
  return (
    <Drawer open onClose={onClose} title={t('policy.new_incident')} footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button icon={<Send className="size-4" />} loading={busy} disabled={description.trim().length < 5 || (needsBooking ? !bookingId.trim() : !bookingId.trim() && !customer)} onClick={submit}>{t('policy.submit')}</Button></>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Alert tone="info">{t('policy.one_report_note')}</Alert>
        <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
        <Field label={t('fields.category')} required>{(p) => <Select {...p} value={type} onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}>{TYPES.map((x) => <option key={x} value={x}>{t(`policy.types.${x}`)}</option>)}</Select>}</Field>
        <Field label={t('policy.booking_id')} hint={t('policy.booking_hint')} required={needsBooking}>{(p) => <Input {...p} dir="ltr" value={bookingId} onChange={(e) => setBookingId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />}</Field>
        {!needsBooking && access.can('customers.view') ? <><CustomerPicker label={t('policy.customer_id')} value={customer} onChange={setCustomer} /><p className="text-xs text-ink-muted">{t('policy.customer_hint')}</p></> : null}
        <Field label={t('policy.description')} hint={t('policy.description_hint')} required>{(p) => <Textarea {...p} rows={4} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        {!needsBooking ? <Field label={t('policy.occurred_at')}>{(p) => <Input {...p} type="datetime-local" value={occurred} onChange={(e) => setOccurred(e.target.value)} />}</Field> : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('policy.evidence')}</legend>
          {evidence.length ? (
            <ul className="flex flex-wrap gap-2">
              {evidence.map((e, i) => (
                <li key={i} className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs">
                  {e.preview ? <img src={e.preview} alt={t('policy.evidence')} className="size-10 rounded object-cover" /> : <span>{e.note}</span>}
                  <IconButton label={t('actions.delete')} onClick={() => setEvidence((x) => x.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></IconButton>
                </li>
              ))}
            </ul>
          ) : null}
          <input ref={fileRef} type="file" accept="image/*" className="sr-only" aria-label={t('policy.upload_evidence')} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" icon={<ImagePlus className="size-4" />} loading={uploading} onClick={() => fileRef.current?.click()}>{t('policy.upload_evidence')}</Button>
          </div>
          <div className="flex gap-2">
            <label htmlFor="ev-note" className="sr-only">{t('policy.evidence_note')}</label>
            <Input id="ev-note" value={note} maxLength={500} placeholder={t('policy.evidence_note')} onChange={(e) => setNote(e.target.value)} />
            <Button variant="secondary" size="md" disabled={!note.trim()} onClick={() => { setEvidence((x) => [...x, { note: note.trim() }]); setNote(''); }}>{t('policy.add_note')}</Button>
          </div>
        </fieldset>
      </form>
    </Drawer>
  );
}

type IncidentDetail = {
  id: string; type: string; status: string; description: string; occurred_at: string; created_at: string; tenant_customer_id: string; customer_user_id: string | null;
  customer_name: string; booking_number: string | null; booking_starts_at: string | null; booking_status: string | null; submitted_by_name: string | null;
  escalation_status: string | null; escalation_note: string | null; escalated_to_platform_at: string | null;
  evidence: Array<{ id: string; note: string | null; url: string | null; created_at: string }>;
  reviews: Array<{ id: string; from_status: string; to_status: string; note: string; created_at: string; reviewer_scope: string; reviewer_name: string | null }>;
  appeals: Array<{ id: string; status: string; created_at: string }>;
  allowed_transitions: string[];
};

export function IncidentDrawer({ id, onClose, onCreateDecision }: { id: string; onClose: () => void; onCreateDecision: (p: DecisionPrefill) => void }) {
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const reviewer = access.can('incidents.review') && !access.readOnly;
  const q = useApiQuery<IncidentDetail>(['incident', access.slug, id], access.api(`/policies/incidents/${id}`));
  const sugg = useApiQuery<{ suggestions: Array<{ rule_id: string; key: string; suggested_action: string; matched_incidents: number; is_experimental: boolean }> }>(
    ['suggestions', access.slug, q.data?.tenant_customer_id], reviewer && q.data ? access.api(`/policies/suggestions?tenant_customer_id=${q.data.tenant_customer_id}`) : null);
  const [to, setTo] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [corrected, setCorrected] = useState('');
  const [escalating, setEscalating] = useState(false);
  const [escNote, setEscNote] = useState('');
  const [evNote, setEvNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const fmt = (v: string) => formatDateTime(v, { locale, tz: access.timezone, timeFormat });

  async function act(path: string, body: unknown, withStepUp = false) {
    setBusy(true); setErr(null);
    try {
      const call = () => api(access.api(path), { body });
      await (withStepUp ? stepUp(call) : call());
      await Promise.all([qc.invalidateQueries({ queryKey: ['incident', access.slug, id] }), qc.invalidateQueries({ queryKey: ['incidents', access.slug] }), qc.invalidateQueries({ queryKey: ['audit', access.slug, id] })]);
      setTo(null); setNote(''); setCorrected(''); setEscalating(false); setEscNote(''); setEvNote('');
    } catch (e) { if (!(e instanceof ApiError && e.message === 'cancelled')) setErr(e); } finally { setBusy(false); }
  }

  const d = q.data;
  return (
    <Drawer open onClose={onClose} wide title={d ? `${t(`policy.types.${d.type}`)} — ${d.customer_name}` : t('states.loading')}>
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <LoadingState rows={6} /> : (
        <div className="flex flex-col gap-4">
          <FormErrorSummary message={err ? msg(err) : null} />
          <div className="flex flex-wrap items-center gap-2">
            <IncidentStatus status={d.status} />
            {d.escalation_status ? <Badge tone="info">{t(`policy.escalation.${d.escalation_status}`)}</Badge> : null}
            <span className="text-xs text-ink-muted">{t('policy.occurred_at')}: {fmt(d.occurred_at)}</span>
          </div>
          <Card>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-ink-muted">{t('policy.customer_id')}</dt><dd>{d.customer_name}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('policy.booking')}</dt><dd>{d.booking_number ? <span dir="ltr" className="font-mono text-xs">{d.booking_number}</span> : '—'}{d.booking_starts_at ? ` · ${fmt(d.booking_starts_at)}` : ''}{d.booking_status ? ` · ${t(`account.booking_status.${d.booking_status}`)}` : ''}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('policy.submitted_by')}</dt><dd>{d.submitted_by_name ?? '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('fields.date')}</dt><dd>{fmt(d.created_at)}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-ink-muted">{t('policy.description')}</dt><dd className="whitespace-pre-wrap">{d.description}</dd></div>
              {d.escalation_note ? <div className="sm:col-span-2"><dt className="text-xs text-ink-muted">{t('policy.escalation_note')}</dt><dd>{d.escalation_note}</dd></div> : null}
            </dl>
          </Card>

          <Card title={t('policy.evidence')}>
            {d.evidence.length ? (
              <ul className="flex flex-wrap gap-3">
                {d.evidence.map((e) => (
                  <li key={e.id} className="flex max-w-56 flex-col gap-1 text-xs">
                    {e.url ? <a href={e.url} target="_blank" rel="noreferrer"><img src={e.url} alt={t('policy.evidence')} className="h-24 w-32 rounded-lg object-cover" /></a> : null}
                    {e.note ? <span>{e.note}</span> : null}
                    <span className="text-ink-muted">{fmt(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
            {d.status !== 'rejected' && !access.readOnly ? (
              <div className="mt-3 flex gap-2">
                <label htmlFor="add-ev" className="sr-only">{t('policy.evidence_note')}</label>
                <Input id="add-ev" value={evNote} maxLength={500} placeholder={t('policy.evidence_note')} onChange={(e) => setEvNote(e.target.value)} />
                <Button variant="secondary" disabled={!evNote.trim()} loading={busy} onClick={() => act(`/policies/incidents/${id}/evidence`, { note: evNote.trim() })}>{t('policy.add_note')}</Button>
              </div>
            ) : null}
          </Card>

          {reviewer && d.allowed_transitions.length ? (
            <Card title={t('policy.history')}>
              <div className="flex flex-wrap gap-2">
                {d.allowed_transitions.map((x) => <Button key={x} size="sm" variant={to === x ? 'primary' : 'outline'} onClick={() => setTo(x)}>{t(`policy.actions.${x}`)}</Button>)}
              </div>
              {to ? (
                <form className="mt-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void act(`/policies/incidents/${id}/transition`, { to, note, ...(to === 'corrected' && corrected ? { corrected_description: corrected } : {}) }); }}>
                  <Field label={t('policy.note')} required>{(p) => <Textarea {...p} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                  {to === 'corrected' ? <Field label={t('policy.corrected_description')}>{(p) => <Textarea {...p} rows={3} maxLength={2000} value={corrected} onChange={(e) => setCorrected(e.target.value)} />}</Field> : null}
                  <div><Button type="submit" loading={busy} disabled={note.trim().length < 3}>{t(`policy.actions.${to}`)}</Button></div>
                </form>
              ) : null}
            </Card>
          ) : null}

          {reviewer && (d.status === 'confirmed' || d.status === 'corrected') ? (
            <Card>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" icon={<Gavel className="size-4" />} onClick={() => onCreateDecision({ tenantCustomerId: d.tenant_customer_id, customerName: d.customer_name, incidentId: d.id })}>{t('policy.decisions.new')}</Button>
                {!d.escalation_status && d.customer_user_id ? <Button variant="outline" icon={<Send className="size-4" />} onClick={() => setEscalating(true)}>{t('policy.escalate')}</Button> : null}
              </div>
              {escalating ? (
                <form className="mt-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void act(`/policies/incidents/${id}/escalate`, { note: escNote }, true); }}>
                  <Alert tone="info">{t('policy.escalate_hint')}</Alert>
                  <Field label={t('policy.escalation_note')} required>{(p) => <Textarea {...p} rows={2} maxLength={1000} value={escNote} onChange={(e) => setEscNote(e.target.value)} />}</Field>
                  <div><Button type="submit" loading={busy} disabled={escNote.trim().length < 3}>{t('policy.escalate')}</Button></div>
                </form>
              ) : null}
            </Card>
          ) : null}

          {sugg.data?.suggestions.length ? (
            <Card title={<span className="inline-flex items-center gap-2"><Lightbulb className="size-4" aria-hidden />{t('policy.suggestions')}</span>}>
              <p className="mb-2 text-xs text-ink-muted">{t('policy.suggestions_note')}</p>
              <ul className="flex flex-col gap-2 text-sm">
                {sugg.data.suggestions.map((s) => (
                  <li key={s.rule_id} className="flex flex-wrap items-center gap-2">
                    <ActionBadge action={s.suggested_action} /><span>{s.key}</span><span className="text-ink-muted">{t('policy.matched', { n: s.matched_incidents })}</span>
                    {s.is_experimental ? <Badge tone="warn">{t('policy.decisions.experimental')}</Badge> : null}
                    <Button size="sm" variant="ghost" onClick={() => onCreateDecision({ tenantCustomerId: d.tenant_customer_id, customerName: d.customer_name, incidentId: d.id, action: s.suggested_action, ruleId: s.rule_id, experimental: s.is_experimental })}>{t('policy.use_suggestion')}</Button>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card title={t('policy.history')}>
            {d.reviews.length ? (
              <ol className="flex flex-col gap-2 text-sm">
                {d.reviews.map((r) => (
                  <li key={r.id} className="border-s-2 border-luma-200 ps-3">
                    <p className="text-xs text-ink-muted">{fmt(r.created_at)} · {r.reviewer_scope === 'platform' ? t('policy.platform_reviewer') : r.reviewer_name ?? '—'}</p>
                    <p>{t(`policy.statuses.${r.from_status}`)} → {t(`policy.statuses.${r.to_status}`)}</p>
                    <p className="text-ink-muted">{r.note}</p>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
          </Card>
          {access.can('incidents.review', 'audit.view') ? <AuditTrail targetType="incident" targetId={id} /> : null}
        </div>
      )}
    </Drawer>
  );
}

export function AuditTrail({ targetType, targetId }: { targetType: 'incident' | 'policy_decision' | 'appeal' | 'policy_rule'; targetId: string }) {
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const q = useApiQuery<Array<{ id: string; action: string; actor_kind: string; actor_name: string | null; created_at: string }>>(['audit', access.slug, targetId], access.api(`/policies/audit?target_type=${targetType}&target_id=${targetId}`));
  return (
    <Card title={t('policy.audit')}>
      {q.isLoading ? <LoadingState rows={2} /> : q.error ? <ErrorState error={q.error} /> : (
        <ol className="flex flex-col gap-1 text-xs">
          {q.data?.map((a) => (
            <li key={a.id} className="flex flex-wrap gap-2"><span className="text-ink-muted">{formatDateTime(a.created_at, { locale, tz: access.timezone, timeFormat })}</span><span dir="ltr" className="font-mono">{a.action}</span><span>{a.actor_name ?? a.actor_kind}</span></li>
          ))}
        </ol>
      )}
    </Card>
  );
}
