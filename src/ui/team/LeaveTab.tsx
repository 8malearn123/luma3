'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Palmtree, Plus, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiQuery } from '../hooks';
import { Button } from '../components/button';
import { Field, Input, Select, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { Dialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { ApiErrorBox, localToIso, parseRange, todayIn } from '../catalog/common';
import type { StaffRow } from './TeamPage';

type Leave = { id: string; staff_id: string; display_name: string; during: string; leave_type: string; status: string; reason: string | null; affected_booking_ids: string[]; created_at: string };
const STATUSES = ['requested', 'approved', 'rejected', 'cancelled'] as const;
const TYPES = ['annual', 'sick', 'personal', 'other'] as const;
const TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = { requested: 'warn', approved: 'ok', rejected: 'danger', cancelled: 'neutral' };

export function LeaveTab({ staff }: { staff: StaffRow[] }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const { when } = useFmt();
  const [status, setStatus] = useState<string>('requested');
  const q = useApiQuery<Leave[]>(['leave', access.slug, status], access.api(`/leave${status ? `?status=${status}` : ''}`));
  const canDecide = access.can('leave.approve') && !access.readOnly;
  const canRequest = access.can('leave.request', 'schedule.manage') && !access.readOnly && (access.can('schedule.manage') || !!access.staffProfileId);
  const [decide, setDecide] = useState<{ row: Leave; decision: 'approved' | 'rejected' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [requesting, setRequesting] = useState(false);
  const [affected, setAffected] = useState<number | null>(null);

  async function submitDecision() {
    if (!decide) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ affected_booking_ids: string[] }>(access.api(`/leave/${decide.row.id}`), { body: { decision: decide.decision, ...(note.trim() ? { note: note.trim() } : {}) } });
      setAffected(r.affected_booking_ids?.length || null);
      toast({ tone: 'ok', text: decide.decision === 'approved' ? t('catalog_team.leave.approved_done') : t('catalog_team.leave.rejected_done') });
      setDecide(null); setNote('');
      await qc.invalidateQueries({ queryKey: ['leave', access.slug] });
    } catch (e) {
      setErr(e); setDecide(null);
      if (e instanceof ApiError && e.code === 'already_decided') await qc.invalidateQueries({ queryKey: ['leave', access.slug] });
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Select aria-label={t('fields.status')} className="sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`catalog_team.leave.status.${s}`)}</option>)}
          <option value="">{t('catalog_team.leave.all')}</option>
        </Select>
        {canRequest && !requesting ? <Button icon={<Plus className="size-4" />} onClick={() => setRequesting(true)}>{t('catalog_team.leave.request')}</Button> : null}
      </div>
      {affected ? <Alert tone="warn" title={t('team_ui.affected', { n: affected })}>{t('catalog_team.leave.affected_hint')}</Alert> : null}
      <ApiErrorBox err={err} />
      {requesting ? <RequestForm staff={staff} onDone={() => setRequesting(false)} /> : null}
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={<Palmtree className="size-8" aria-hidden />} title={status === 'requested' ? t('catalog_team.leave.empty_pending') : t('states.empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {q.data.map((l) => {
            const r = parseRange(l.during);
            const s = staff.find((x) => x.id === l.staff_id);
            return (
              <li key={l.id} className="flex flex-col gap-3 rounded-xl border border-line bg-white p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s ? pick(s.display_name, s.display_name_en) : l.display_name}</span>
                    <Badge tone={TONE[l.status] ?? 'neutral'}>{t(`catalog_team.leave.status.${l.status}`)}</Badge>
                    <Badge>{t(`catalog_team.leave.types.${l.leave_type}`)}</Badge>
                    {l.affected_booking_ids.length ? <Badge tone="warn">{t('team_ui.affected', { n: l.affected_booking_ids.length })}</Badge> : null}
                  </p>
                  {r ? <p className="mt-1 text-sm">{when(r.from)} – {when(r.to)}</p> : null}
                  {l.reason ? <p className="mt-1 text-xs text-ink-muted">{l.reason}</p> : null}
                </div>
                {l.status === 'requested' && canDecide ? (
                  <div className="flex gap-2">
                    <Button size="sm" icon={<Check className="size-4" />} onClick={() => { setNote(''); setDecide({ row: l, decision: 'approved' }); }}>{t('team_ui.approve')}</Button>
                    <Button size="sm" variant="outline" icon={<X className="size-4" />} onClick={() => { setNote(''); setDecide({ row: l, decision: 'rejected' }); }}>{t('team_ui.reject')}</Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={!!decide} onClose={() => setDecide(null)} title={decide?.decision === 'approved' ? t('catalog_team.leave.approve_title') : t('catalog_team.leave.reject_title')} footer={<>
        <Button variant="ghost" onClick={() => setDecide(null)}>{t('actions.cancel')}</Button>
        <Button variant={decide?.decision === 'rejected' ? 'danger' : 'primary'} loading={busy} onClick={submitDecision}>{decide?.decision === 'approved' ? t('team_ui.approve') : t('team_ui.reject')}</Button>
      </>}>
        <div className="flex flex-col gap-3">
          <p className="text-ink-muted">{decide?.decision === 'approved' ? t('catalog_team.leave.approve_body') : t('catalog_team.leave.reject_body')}</p>
          <Field label={t('catalog_team.leave.note')}>{(fp) => <Textarea {...fp} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </div>
  );
}

function RequestForm({ staff, onDone }: { staff: StaffRow[]; onDone: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = access.can('schedule.manage');
  const start = todayIn(access.timezone, 7);
  const [form, setForm] = useState({ staff_id: manage ? (staff.find((s) => s.is_active)?.id ?? '') : '', from: `${start}T09:00`, to: `${start}T22:00`, leave_type: 'annual', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function submit() {
    const s = localToIso(form.from, access.timezone), e = localToIso(form.to, access.timezone);
    if (!s || !e || e <= s) { setErr(new ApiError(422, 'invalid_range', 'invalid_range')); return; }
    setBusy(true); setErr(null);
    try {
      await api(access.api('/leave'), { body: { ...(manage && form.staff_id ? { staff_id: form.staff_id } : {}), starts_at: s, ends_at: e, leave_type: form.leave_type, ...(form.reason.trim() ? { reason: form.reason.trim() } : {}) } });
      toast({ tone: 'ok', text: t('catalog_team.leave.requested_done') });
      await qc.invalidateQueries({ queryKey: ['leave', access.slug] });
      onDone();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }

  return (
    <Card title={t('catalog_team.leave.request')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><ApiErrorBox err={err} /></div>
        {manage ? (
          <Field label={t('catalog_team.schedule.staff')} required>{(fp) => (
            <Select {...fp} value={form.staff_id} onChange={(e) => setForm({ ...form, staff_id: e.target.value })}>
              {staff.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{pick(s.display_name, s.display_name_en)}</option>)}
            </Select>
          )}</Field>
        ) : null}
        <Field label={t('catalog_team.leave.type')}>{(fp) => (
          <Select {...fp} value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value })}>
            {TYPES.map((x) => <option key={x} value={x}>{t(`catalog_team.leave.types.${x}`)}</option>)}
          </Select>
        )}</Field>
        <Field label={t('fields.from')} required>{(fp) => <Input {...fp} type="datetime-local" dir="ltr" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
        <Field label={t('fields.to')} required>{(fp) => <Input {...fp} type="datetime-local" dir="ltr" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
        <Field label={t('fields.reason')} className="sm:col-span-2">{(fp) => <Textarea {...fp} maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}</Field>
        <div className="flex gap-2 sm:col-span-2">
          <Button loading={busy} disabled={manage && !form.staff_id} onClick={submit}>{t('actions.submit')}</Button>
          <Button variant="ghost" onClick={onDone}>{t('actions.cancel')}</Button>
        </div>
      </div>
    </Card>
  );
}
