'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Inbox, Plus, Save, Settings2, Trash2, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Checkbox, Field, FormErrorSummary, Input, Select, Switch, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { CHAIN_ROLES, ChainSteps, RequestStatusBadge, useDay, useDays, type FieldDef, type HrAction, type HrRequest, type RequestType } from './common';
import { RequestForm } from './RequestForm';

type Scope = 'inbox' | 'all' | 'mine';

/** Team → Requests: approvals inbox, every request with its history, and (owner) request types and HR settings. */
export function RequestsTab({ staff, openId, onOpen }: { staff: Array<{ id: string; display_name: string; is_active: boolean }>; openId: string | null; onOpen: (id: string | null) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const configure = access.can('hr.configure');
  const [scope, setScope] = useState<Scope>('inbox');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useApiQuery<HrRequest[]>(['hr-requests', access.slug, scope, status], access.api(`/hr/requests?scope=${scope}${status ? `&status=${status}` : ''}`));
  const canSubmit = !access.readOnly && (access.can('schedule.manage') || (access.can('hr.request') && !!access.staffProfileId));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {(['inbox', 'all', ...(access.staffProfileId ? ['mine'] as const : [])] as Scope[]).map((s) => (
            <Button key={s} size="sm" variant={scope === s ? 'primary' : 'outline'} onClick={() => setScope(s)}>{t(`hr.requests.scope.${s}`)}</Button>
          ))}
          {scope !== 'inbox' ? (
            <Select aria-label={t('fields.status')} className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('hr.requests.all_statuses')}</option>
              {(['pending', 'approved', 'rejected', 'cancelled'] as const).map((s) => <option key={s} value={s}>{t(`hr.status.${s}`)}</option>)}
            </Select>
          ) : null}
        </div>
        {canSubmit && !creating ? <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('hr.request.new')}</Button> : null}
      </div>
      {creating ? <Card title={t('hr.request.new')}><RequestForm staff={access.can('schedule.manage') ? staff : undefined} onDone={() => setCreating(false)} /></Card> : null}
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={<Inbox className="size-8" aria-hidden />} title={scope === 'inbox' ? t('hr.requests.inbox_empty') : t('states.empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {q.data.map((r) => <RequestRow key={r.id} r={r} onOpen={() => onOpen(r.id)} />)}
        </ul>
      )}
      {configure ? <TypesCard /> : null}
      {configure ? <SettingsCard /> : null}
      {openId ? <RequestDrawer id={openId} onClose={() => onOpen(null)} /> : null}
    </div>
  );
}

function RequestRow({ r, onOpen }: { r: HrRequest; onOpen: () => void }) {
  const { t, pick } = useI18n();
  const { money } = useFmt();
  const day = useDay();
  const days = useDays();
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full flex-col gap-2 rounded-xl border border-line bg-white p-4 text-start hover:border-luma-300 sm:flex-row sm:items-center">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{r.staff_name}</span>
            <Badge>{pick(r.type_name_ar, r.type_name_en)}</Badge>
            <RequestStatusBadge status={r.status} />
            {r.can_act ? <Badge tone="info">{t('hr.requests.your_turn')}</Badge> : null}
            {r.balance_warning ? <Badge tone="warn">{t('hr.requests.over_balance')}</Badge> : null}
          </span>
          <span className="mt-1 block text-sm">
            {r.kind === 'leave' && r.starts_on ? `${day(r.starts_on)}${r.ends_on !== r.starts_on ? ` – ${day(r.ends_on)}` : ''} · ${t('hr.balance.days', { n: days(r.leave_days) })}` : null}
            {r.kind === 'advance' && r.amount_minor ? <span dir="ltr">{money(r.amount_minor)} / {r.installments}</span> : null}
          </span>
          <span className="mt-1 block"><ChainSteps chain={r.approval_chain} current={r.current_step} status={r.status} /></span>
        </span>
      </button>
    </li>
  );
}

export function RequestDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const { money, when } = useFmt();
  const day = useDay();
  const days = useDays();
  const q = useApiQuery<HrRequest & { fields: FieldDef[]; actions: HrAction[] }>(['hr-request', access.slug, id], access.api(`/hr/requests/${id}`));
  const [note, setNote] = useState('');
  const [inst, setInst] = useState('');
  const [method, setMethod] = useState<'cash' | 'bank_transfer'>('cash');
  const decide = useApiMutation((decision: 'approved' | 'rejected') => api<{ status: string; affected_booking_ids: string[] }>(access.api(`/hr/requests/${id}/decide`), {
    body: { decision, ...(note.trim() ? { note: note.trim() } : {}), ...(q.data?.kind === 'advance' ? { method, ...(inst ? { installments: Number(inst) } : {}) } : {}) },
  }), {
    invalidate: [['hr-requests', access.slug], ['hr-request', access.slug, id], ['leave', access.slug], ['hr-balances', access.slug]],
    onSuccess: (r) => {
      toast({ tone: 'ok', text: r.status === 'pending' ? t('hr.requests.step_done') : r.status === 'approved' ? t('hr.requests.approved_done') : t('hr.requests.rejected_done') });
      if (r.affected_booking_ids?.length) toast({ tone: 'info', text: t('hr.reroute.affected_toast', { n: r.affected_booking_ids.length }) });
      setNote('');
    },
  });
  const cancel = useApiMutation(() => api(access.api(`/hr/requests/${id}/cancel`), { body: {} }), {
    invalidate: [['hr-requests', access.slug], ['hr-request', access.slug, id], ['portal', access.slug]], onSuccess: () => toast({ tone: 'ok', text: t('hr.requests.cancelled_done') }),
  });
  const r = q.data;
  return (
    <Drawer open onClose={onClose} title={r ? `${pick(r.type_name_ar, r.type_name_en)} — ${r.staff_name}` : t('hr.requests.title')}>
      {q.isLoading ? <LoadingState rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : r ? (
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-wrap items-center gap-2"><RequestStatusBadge status={r.status} /><ChainSteps chain={r.approval_chain} current={r.current_step} status={r.status} /></div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {r.kind === 'leave' && r.starts_on ? <><dt className="text-ink-muted">{t('hr.request.period')}</dt><dd>{day(r.starts_on)} – {day(r.ends_on)} ({t('hr.balance.days', { n: days(r.leave_days) })})</dd></> : null}
            {r.kind === 'advance' ? <><dt className="text-ink-muted">{t('hr.request.amount')}</dt><dd dir="ltr" className="text-start">{money(r.amount_minor)} · {t('hr.request.n_installments', { n: r.installments ?? 1 })}</dd></> : null}
            {r.fields.map((f) => r.field_values[f.key] != null ? <div key={f.key} className="contents"><dt className="text-ink-muted">{pick(f.label_ar, f.label_en)}</dt><dd>{String(r.field_values[f.key])}</dd></div> : null)}
            {r.note ? <><dt className="text-ink-muted">{t('hr.request.note')}</dt><dd className="whitespace-pre-line">{r.note}</dd></> : null}
          </dl>
          {r.balance_warning ? <Alert tone="warn">{t('hr.requests.over_balance_hint')}</Alert> : null}
          <div>
            <h3 className="mb-2 font-semibold">{t('hr.requests.history')}</h3>
            <ol className="flex flex-col gap-2 border-s border-line ps-3">
              {r.actions.map((a) => (
                <li key={a.id}>
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={a.action === 'approved' ? 'ok' : a.action === 'rejected' ? 'danger' : 'neutral'}>{t(`hr.actions.${a.action}`)}</Badge>
                    {a.role ? <span className="text-xs text-ink-muted">{t(`hr.roles.${a.role}`)}</span> : null}
                    {a.actor_name ? <span>{a.actor_name}</span> : a.actor_role ? <span>{t(`hr.roles.${a.actor_role}`)}</span> : null}
                    <span className="ms-auto text-xs text-ink-muted">{when(a.created_at)}</span>
                  </p>
                  {a.note ? <p className="mt-0.5 text-ink-muted">{a.note}</p> : null}
                  {a.data && (a.data as { installments?: { from: number; to: number } }).installments ? (
                    <p className="text-xs text-ink-muted">{t('hr.requests.installments_changed', { from: (a.data as { installments: { from: number } }).installments.from, to: (a.data as { installments: { to: number } }).installments.to })}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
          {r.can_act && !access.readOnly ? (
            <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
              <FormErrorSummary message={decide.error ? msg(decide.error) : null} />
              {r.kind === 'advance' ? (
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('hr.request.installments')}>{(p) => <Input {...p} type="number" min={1} max={36} dir="ltr" placeholder={String(r.installments ?? 1)} value={inst} onChange={(e) => setInst(e.target.value)} />}</Field>
                  <Field label={t('hr.requests.payout')}>{(p) => (
                    <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'bank_transfer')}>
                      <option value="cash">{t('payroll.methods.cash')}</option>
                      <option value="bank_transfer">{t('payroll.methods.bank_transfer')}</option>
                    </Select>
                  )}</Field>
                </div>
              ) : null}
              <Field label={t('hr.requests.decision_note')} hint={t('fields.optional')}>{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              <div className="flex gap-2">
                <Button icon={<Check className="size-4" />} loading={decide.isPending && decide.variables === 'approved'} onClick={() => decide.mutate('approved')}>{t('hr.requests.approve')}</Button>
                <Button variant="outline" icon={<X className="size-4" />} loading={decide.isPending && decide.variables === 'rejected'} onClick={() => decide.mutate('rejected')}>{t('hr.requests.reject')}</Button>
              </div>
              {access.role === 'owner' && r.current_step < r.approval_chain.length - 1 ? <p className="text-xs text-ink-muted">{t('hr.requests.owner_final')}</p> : null}
            </div>
          ) : null}
          {r.can_cancel && !access.readOnly ? (
            <div>
              <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(undefined)}>{t('hr.requests.cancel')}</Button>
              {cancel.error ? <p className="text-xs text-danger">{msg(cancel.error)}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

// ── Owner: request types ────────────────────────────────────────────────────
function TypesCard() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const q = useApiQuery<RequestType[]>(['hr-types', access.slug, 'all'], access.api('/hr/request-types?include_inactive=1'));
  const [edit, setEdit] = useState<RequestType | 'new' | null>(null);
  return (
    <Card title={t('hr.types.title')} actions={!access.readOnly ? <Button size="sm" variant="outline" icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>{t('hr.types.new')}</Button> : null}>
      <p className="mb-3 text-xs text-ink-muted">{t('hr.types.hint')}</p>
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <ul className="divide-y divide-line">
          {(q.data ?? []).map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-medium">{pick(x.name_ar, x.name_en)}</span>
              <Badge>{t(`hr.kinds.${x.kind}`)}</Badge>
              {!x.is_active ? <Badge tone="danger">{t('fields.inactive')}</Badge> : null}
              {x.fields.length ? <span className="text-xs text-ink-muted">{t('hr.types.n_fields', { n: x.fields.length })}</span> : null}
              <span className="ms-auto flex items-center gap-2"><ChainSteps chain={x.approval_chain} />
                {!access.readOnly ? <IconButton label={t('actions.edit')} onClick={() => setEdit(x)}><Settings2 className="size-4" aria-hidden /></IconButton> : null}</span>
            </li>
          ))}
        </ul>
      )}
      {edit ? <TypeDrawer key={edit === 'new' ? 'new' : edit.id} type={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.refetch(); }} /> : null}
    </Card>
  );
}

function TypeDrawer({ type, onClose, onSaved }: { type: RequestType | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const [nameAr, setNameAr] = useState(type?.name_ar ?? '');
  const [nameEn, setNameEn] = useState(type?.name_en ?? '');
  const [kind, setKind] = useState<'other' | 'letter' | 'leave'>('other');
  const [leaveType, setLeaveType] = useState('unpaid');
  const [chain, setChain] = useState<string[]>(type?.approval_chain ?? ['owner']);
  const [fields, setFields] = useState<Array<FieldDef & { optionsText?: string }>>((type?.fields ?? []).map((f) => ({ ...f, optionsText: (f.options ?? []).join('، ') })));
  const [active, setActive] = useState(type?.is_active ?? true);
  const move = (i: number, d: number) => { const c = [...chain]; const [x] = c.splice(i, 1); c.splice(i + d, 0, x!); setChain(c); };
  const cleanFields = fields.map(({ optionsText, ...f }) => ({
    key: f.key, label_ar: f.label_ar.trim(), ...(f.label_en?.trim() ? { label_en: f.label_en.trim() } : {}), type: f.type, required: !!f.required,
    ...(f.type === 'select' ? { options: (optionsText ?? '').split(/[,،\n]/).map((o) => o.trim()).filter(Boolean) } : {}),
  }));
  const valid = nameAr.trim() && chain.length >= 1 && cleanFields.every((f) => f.label_ar && (f.type !== 'select' || (f.options?.length ?? 0) > 0));
  const m = useApiMutation(() => (type
    ? api(access.api(`/hr/request-types/${type.id}`), { method: 'PATCH', body: { name_ar: nameAr.trim(), name_en: nameEn.trim() || null, approval_chain: chain, fields: cleanFields, is_active: active } })
    : api(access.api('/hr/request-types'), { body: { name_ar: nameAr.trim(), name_en: nameEn.trim() || null, kind, ...(kind === 'leave' ? { leave_type: leaveType } : {}), approval_chain: chain, fields: cleanFields } })), {
    invalidate: [['hr-types', access.slug]], onSuccess: () => { toast({ tone: 'ok', text: t('states.saved') }); onSaved(); },
  });
  const nextKey = () => { let i = fields.length + 1; while (fields.some((f) => f.key === `field_${i}`)) i++; return `field_${i}`; };
  return (
    <Drawer open onClose={onClose} title={type ? t('hr.types.edit') : t('hr.types.new')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button icon={<Save className="size-4" />} disabled={!valid} loading={m.isPending} onClick={() => m.mutate(undefined)}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={m.error ? msg(m.error) : null} />
        <Field label={t('hr.types.name_ar')} required>{(p) => <Input {...p} dir="rtl" maxLength={80} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}</Field>
        <Field label={t('hr.types.name_en')} hint={t('fields.optional')}>{(p) => <Input {...p} dir="ltr" maxLength={80} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}</Field>
        {!type ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('hr.types.kind')}>{(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {(['other', 'letter', 'leave'] as const).map((k) => <option key={k} value={k}>{t(`hr.kinds.${k}`)}</option>)}
              </Select>
            )}</Field>
            {kind === 'leave' ? (
              <Field label={t('hr.types.leave_type')} hint={t('hr.types.leave_type_hint')}>{(p) => (
                <Select {...p} value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
                  {(['annual', 'sick', 'emergency', 'unpaid'] as const).map((k) => <option key={k} value={k}>{t(`hr.leave_kinds.${k}`)}</option>)}
                </Select>
              )}</Field>
            ) : null}
          </div>
        ) : null}
        <div>
          <p className="text-sm font-medium">{t('hr.types.chain')}</p>
          <p className="mb-2 text-xs text-ink-muted">{t('hr.types.chain_hint')}</p>
          <ol className="flex flex-col gap-2">
            {chain.map((role, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-6 text-center text-xs text-ink-muted">{i + 1}</span>
                <Select aria-label={t('hr.types.step_n', { n: i + 1 })} value={role} onChange={(e) => setChain(chain.map((r, j) => (j === i ? e.target.value : r)))}>
                  {CHAIN_ROLES.map((r) => <option key={r} value={r}>{t(`hr.roles.${r}`)}</option>)}
                </Select>
                <IconButton label={t('hr.types.up')} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" aria-hidden /></IconButton>
                <IconButton label={t('hr.types.down')} disabled={i === chain.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" aria-hidden /></IconButton>
                <IconButton label={t('hr.types.remove_step')} disabled={chain.length === 1} onClick={() => setChain(chain.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden /></IconButton>
              </li>
            ))}
          </ol>
          {chain.length < 5 ? <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setChain([...chain, 'owner'])}>{t('hr.types.add_step')}</Button> : null}
        </div>
        <div>
          <p className="text-sm font-medium">{t('hr.types.fields')}</p>
          <p className="mb-2 text-xs text-ink-muted">{t('hr.types.fields_hint')}</p>
          <div className="flex flex-col gap-3">
            {fields.map((f, i) => (
              <div key={f.key} className="rounded-lg border border-line p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label={t('hr.types.field_label')} required>{(p) => <Input {...p} maxLength={80} value={f.label_ar} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, label_ar: e.target.value } : x)))} />}</Field>
                  <Field label={t('hr.types.field_type')}>{(p) => (
                    <Select {...p} value={f.type} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, type: e.target.value as FieldDef['type'] } : x)))}>
                      {(['text', 'number', 'date', 'select'] as const).map((k) => <option key={k} value={k}>{t(`hr.field_types.${k}`)}</option>)}
                    </Select>
                  )}</Field>
                  {f.type === 'select' ? (
                    <Field label={t('hr.types.field_options')} hint={t('hr.types.field_options_hint')} className="sm:col-span-2">{(p) => <Input {...p} value={f.optionsText ?? ''} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, optionsText: e.target.value } : x)))} />}</Field>
                  ) : null}
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <Checkbox label={t('hr.types.field_required')} checked={!!f.required} onChange={(v) => setFields(fields.map((x, j) => (j === i ? { ...x, required: v } : x)))} />
                  <IconButton label={t('hr.types.remove_field')} onClick={() => setFields(fields.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden /></IconButton>
                </div>
              </div>
            ))}
          </div>
          {fields.length < 15 ? <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setFields([...fields, { key: nextKey(), label_ar: '', type: 'text', required: false }])}>{t('hr.types.add_field')}</Button> : null}
        </div>
        {type ? <Switch label={t('hr.types.active')} checked={active} onChange={setActive} /> : null}
      </div>
    </Drawer>
  );
}

// ── Owner: HR settings ──────────────────────────────────────────────────────
function SettingsCard() {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const q = useApiQuery<{ grace_minutes: number; leave_balance_policy: 'block' | 'warn'; attendance_deductions: boolean }>(['hr-settings', access.slug], access.api('/hr/settings'));
  const [grace, setGrace] = useState<string | null>(null);
  const save = useApiMutation((body: Record<string, unknown>) => api(access.api('/hr/settings'), { method: 'PATCH', body }), {
    invalidate: [['hr-settings', access.slug]], onSuccess: () => { setGrace(null); toast({ tone: 'ok', text: t('states.saved') }); },
  });
  if (q.isLoading) return <LoadingState rows={2} />;
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const g = grace ?? String(q.data.grace_minutes);
  const gn = Number(g);
  const lock = access.readOnly;
  return (
    <Card title={t('hr.settings.title')}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={save.error ? msg(save.error) : null} />
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('hr.settings.grace')} hint={t('hr.settings.grace_hint')}>{(p) => <Input {...p} className="w-28" type="number" min={0} max={240} dir="ltr" disabled={lock} value={g} onChange={(e) => setGrace(e.target.value)} />}</Field>
          {grace != null ? <Button size="sm" disabled={!Number.isInteger(gn) || gn < 0 || gn > 240} loading={save.isPending} onClick={() => save.mutate({ grace_minutes: gn })}>{t('actions.save')}</Button> : null}
        </div>
        <Field label={t('hr.settings.balance_policy')}>{(p) => (
          <Select {...p} className="sm:w-80" disabled={lock} value={q.data!.leave_balance_policy} onChange={(e) => save.mutate({ leave_balance_policy: e.target.value })}>
            <option value="block">{t('hr.settings.policy_block')}</option>
            <option value="warn">{t('hr.settings.policy_warn')}</option>
          </Select>
        )}</Field>
        <div>
          <Switch label={<span className="font-medium">{t('hr.settings.deductions')}</span>} checked={q.data.attendance_deductions} disabled={lock} onChange={(v) => save.mutate({ attendance_deductions: v })} />
          <p className="ms-11 mt-1 text-xs text-ink-muted">{t('hr.settings.deductions_hint')}</p>
        </div>
      </div>
    </Card>
  );
}
