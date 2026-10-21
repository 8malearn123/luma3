'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, FlaskConical, MailPlus, Pencil, UserMinus, Users } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { canAssignRole, delegableFor, TENANT_ROLES, type Capability, type TenantRole } from '@/server/auth/capabilities';
import { api, ApiError } from '../api';
import { useApiQuery } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Checkbox, Field, Input, Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { ConfirmDialog, Dialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useStepUp } from '../platform/stepup';
import { useFmt } from '../commerce/common';
import { ApiErrorBox } from '../catalog/common';
import type { StaffRow } from './TeamPage';

type Member = {
  id: string; user_id: string; role: TenantRole; status: string; granted_capabilities: string[]; revoked_capabilities: string[]; staff_profile_id: string | null; created_at: string;
  user: { id: string; display_name: string | null; email: string | null; phone: string | null } | null;
};
type Invitation = { id: string; email: string | null; phone: string | null; role: TenantRole; expires_at: string; created_at: string };
type InviteResult = { id: string; expires_at: string; delivery: 'sent' | 'simulated' | 'failed' | 'unavailable'; dev_invite_link?: string };

const ASSIGNABLE = TENANT_ROLES.filter((r) => r !== 'owner');

function useAssign() {
  const access = useAccess();
  const caps = new Set(access.capabilities as Capability[]);
  return (target: TenantRole) => access.role !== 'support' && canAssignRole(access.role as TenantRole, caps, target);
}

export function MembersTab({ staff, inviteFor, onInviteHandled }: { staff: StaffRow[]; inviteFor: string | null; onInviteHandled: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const { when } = useFmt();
  const canAssign = useAssign();
  const q = useApiQuery<{ members: Member[]; pending_invitations: Invitation[] }>(['members', access.slug], access.api('/members'));
  const session = useApiQuery<{ user: { id: string } | null }>(['session'], '/api/v1/auth/session');
  // Deep link from a staff profile: ?tab=members&invite=<staffId> opens the invite form.
  const [inviting, setInviting] = useState<{ staffId: string | null } | null>(() => (inviteFor ? { staffId: inviteFor } : null));
  const [editing, setEditing] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revokeInv, setRevokeInv] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const writable = !access.readOnly;

  const staffName = (id: string | null) => { if (!id) return null; const s = staff.find((x) => x.id === id); return s ? pick(s.display_name, s.display_name_en) : null; };
  const isOwnRow = (m: Member) => !session.data?.user || m.user_id === session.data.user.id;

  async function run(fn: () => Promise<unknown>, done: () => void, okText: string) {
    setBusy(true); setErr(null);
    try { await stepUp(fn); done(); toast({ tone: 'ok', text: okText }); await qc.invalidateQueries({ queryKey: ['members', access.slug] }); qc.invalidateQueries({ queryKey: ['staff', access.slug] }); }
    catch (e) { if (!(e instanceof ApiError && e.code === 'reauthentication_required')) setErr(e); done(); } finally { setBusy(false); }
  }

  if (q.isLoading) return <LoadingState rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { members, pending_invitations: invites } = q.data!;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">{t('catalog_team.members.hint')}</p>
        {writable ? <Button icon={<MailPlus className="size-4" />} onClick={() => setInviting({ staffId: null })}>{t('team_ui.invite')}</Button> : null}
      </div>
      <ApiErrorBox err={err} />

      <Card title={t('team_ui.members')}>
        {!members.length ? <EmptyState icon={<Users className="size-8" aria-hidden />} /> : (
          <ul className="flex flex-col divide-y divide-line">
            {members.map((m) => {
              const editable = writable && m.role !== 'owner' && !isOwnRow(m) && canAssign(m.role);
              const linked = staffName(m.staff_profile_id);
              return (
                <li key={m.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{m.user?.display_name ?? '—'}</span>
                      <Badge tone={m.role === 'owner' ? 'brand' : 'neutral'}>{t(`dashboard.roles.${m.role}`)}</Badge>
                      {m.status !== 'active' ? <Badge tone="warn">{t(`catalog_team.members.status.${m.status}`)}</Badge> : null}
                      {isOwnRow(m) ? <Badge tone="info">{t('catalog_team.members.you')}</Badge> : null}
                    </p>
                    <p className="truncate text-xs text-ink-muted" dir="ltr">{m.user?.email ?? m.user?.phone ?? ''}</p>
                    {linked ? <p className="text-xs text-ink-muted">{t('catalog_team.members.linked_to', { name: linked })}</p> : null}
                    {m.granted_capabilities.length ? <p className="mt-1 flex flex-wrap gap-1">{m.granted_capabilities.map((c) => <Badge key={c} tone="info">{t(`catalog_team.caps.${c}`)}</Badge>)}</p> : null}
                  </div>
                  {editable ? (
                    <div className="flex gap-1">
                      <IconButton label={t('actions.edit')} onClick={() => setEditing(m)}><Pencil className="size-4" /></IconButton>
                      <IconButton label={t('catalog_team.members.revoke')} onClick={() => setRemoving(m)}><UserMinus className="size-4" /></IconButton>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title={t('team_ui.invitations')}>
        {!invites.length ? <p className="text-sm text-ink-muted">{t('catalog_team.members.no_invites')}</p> : (
          <ul className="flex flex-col divide-y divide-line">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate" dir="ltr">{i.email ?? i.phone}</span>
                <Badge>{t(`dashboard.roles.${i.role}`)}</Badge>
                <span className="text-xs text-ink-muted">{t('catalog_team.members.expires', { when: when(i.expires_at) })}</span>
                {writable ? <Button size="sm" variant="ghost" onClick={() => setRevokeInv(i)}>{t('catalog_team.members.revoke_invite')}</Button> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {inviting ? <InviteDialog staff={staff} staffId={inviting.staffId} onClose={() => { setInviting(null); if (inviteFor) onInviteHandled(); }} /> : null}
      {editing ? <EditMemberDialog member={editing} staff={staff} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} loading={busy} danger title={t('catalog_team.members.revoke_title')}
        body={t('catalog_team.members.revoke_body', { name: removing?.user?.display_name ?? '' })} confirmLabel={t('catalog_team.members.revoke')}
        onConfirm={() => run(() => api(access.api(`/members/${removing!.id}`), { method: 'PATCH', body: { status: 'removed' } }), () => setRemoving(null), t('catalog_team.members.revoked'))} />
      <ConfirmDialog open={!!revokeInv} onClose={() => setRevokeInv(null)} loading={busy} danger title={t('catalog_team.members.revoke_invite')}
        body={t('catalog_team.members.revoke_invite_body', { who: revokeInv?.email ?? revokeInv?.phone ?? '' })} confirmLabel={t('catalog_team.members.revoke_invite')}
        onConfirm={() => run(() => api(access.api(`/invitations/${revokeInv!.id}`), { method: 'DELETE' }), () => setRevokeInv(null), t('catalog_team.members.invite_revoked'))} />
    </div>
  );
}

function CapabilityPicker({ role, value, onChange }: { role: TenantRole; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useI18n();
  const list = delegableFor(role);
  if (!list.length) return <p className="text-xs text-ink-muted">{t('catalog_team.members.no_delegable')}</p>;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{t('team_ui.capabilities')}</legend>
      <p className="text-xs text-ink-muted">{t('catalog_team.members.caps_hint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {list.map((c) => <Checkbox key={c} label={t(`catalog_team.caps.${c}`)} checked={value.includes(c)} onChange={(on) => onChange(on ? [...value, c] : value.filter((x) => x !== c))} />)}
      </div>
    </fieldset>
  );
}

function InviteDialog({ staff, staffId, onClose }: { staff: StaffRow[]; staffId: string | null; onClose: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { when } = useFmt();
  const qc = useQueryClient();
  const canAssign = useAssign();
  const roles = ASSIGNABLE.filter((r) => canAssign(r));
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState<TenantRole>(staffId ? 'specialist' : roles.includes('receptionist') ? 'receptionist' : roles[0] ?? 'specialist');
  const [caps, setCaps] = useState<string[]>([]);
  const [linkStaff, setLinkStaff] = useState(staffId ?? '');
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const allowed = new Set<string>(delegableFor(role));
      const r = await api<InviteResult>(access.api('/invitations'), { body: {
        identifier: identifier.trim(), role, granted_capabilities: caps.filter((c) => allowed.has(c)), staff_profile_id: linkStaff || null, expires_in_days: Number(days),
      } });
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['members', access.slug] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} title={t('catalog_team.members.invite_title')} footer={result ? <Button onClick={onClose}>{t('actions.done')}</Button> : <>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button loading={busy} disabled={identifier.trim().length < 3 || !roles.length} onClick={submit}>{t('catalog_team.members.send_invite')}</Button>
    </>}>
      {result ? (
        <div className="flex flex-col gap-3">
          <Alert tone={result.delivery === 'sent' ? 'ok' : result.delivery === 'simulated' ? 'info' : 'warn'} title={t(`catalog_team.members.delivery.${result.delivery}`)}>
            {t('catalog_team.members.invite_expires', { when: when(result.expires_at) })}
          </Alert>
          {result.dev_invite_link ? (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-info/40 bg-info-bg/50 p-3">
              <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-info"><FlaskConical className="size-4" aria-hidden />{t('team_ui.invite_link_dev')}</p>
              <p className="text-xs text-ink-muted">{t('catalog_team.members.dev_only')}</p>
              <code className="break-all rounded bg-white p-2 text-xs" dir="ltr">{result.dev_invite_link}</code>
              <Button size="sm" variant="outline" className="self-start" icon={<Copy className="size-4" />}
                onClick={async () => { try { await navigator.clipboard.writeText(result.dev_invite_link!); setCopied(true); } catch { /* clipboard blocked */ } }}>{copied ? t('actions.copied') : t('actions.copy')}</Button>
            </div>
          ) : null}
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <ApiErrorBox err={err} />
          <Field label={t('catalog_team.members.identifier')} hint={t('catalog_team.members.identifier_hint')} required>{(fp) => <Input {...fp} dir="ltr" autoComplete="off" maxLength={254} value={identifier} onChange={(e) => setIdentifier(e.target.value)} />}</Field>
          <Field label={t('team_ui.role')}>{(fp) => (
            <Select {...fp} value={role} onChange={(e) => { setRole(e.target.value as TenantRole); setCaps([]); }}>
              {roles.map((r) => <option key={r} value={r}>{t(`dashboard.roles.${r}`)}</option>)}
            </Select>
          )}</Field>
          <CapabilityPicker role={role} value={caps} onChange={setCaps} />
          {staff.length ? (
            <Field label={t('team_ui.link_staff')}>{(fp) => (
              <Select {...fp} value={linkStaff} onChange={(e) => setLinkStaff(e.target.value)}>
                <option value="">{t('catalog_team.members.no_link')}</option>
                {staff.filter((s) => s.is_active && (!s.has_login || s.id === staffId)).map((s) => <option key={s.id} value={s.id}>{pick(s.display_name, s.display_name_en)}</option>)}
              </Select>
            )}</Field>
          ) : null}
          <Field label={t('catalog_team.members.valid_for')}>{(fp) => (
            <Select {...fp} value={days} onChange={(e) => setDays(e.target.value)}>
              {[1, 3, 7, 14].map((d) => <option key={d} value={d}>{t('catalog_team.members.n_days', { n: d })}</option>)}
            </Select>
          )}</Field>
        </form>
      )}
    </Dialog>
  );
}

function EditMemberDialog({ member, staff, onClose }: { member: Member; staff: StaffRow[]; onClose: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const canAssign = useAssign();
  const roles = ASSIGNABLE.filter((r) => canAssign(r));
  const [role, setRole] = useState<TenantRole>(member.role);
  const [caps, setCaps] = useState<string[]>(member.granted_capabilities);
  const [linkStaff, setLinkStaff] = useState(member.staff_profile_id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function save() {
    setBusy(true); setErr(null);
    const allowed = new Set<string>(delegableFor(role));
    try {
      await stepUp(() => api(access.api(`/members/${member.id}`), { method: 'PATCH', body: {
        role, granted_capabilities: caps.filter((c) => allowed.has(c)), staff_profile_id: linkStaff || null,
      } }));
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['members', access.slug] });
      qc.invalidateQueries({ queryKey: ['staff', access.slug] });
      onClose();
    } catch (e) { if (!(e instanceof ApiError && e.code === 'reauthentication_required')) setErr(e); } finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} title={member.user?.display_name ?? t('team_ui.members')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button loading={busy} onClick={save}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <ApiErrorBox err={err} />
        <p className="text-xs text-ink-muted">{t('catalog_team.members.stepup_note')}</p>
        <Field label={t('team_ui.role')}>{(fp) => (
          <Select {...fp} value={role} onChange={(e) => { setRole(e.target.value as TenantRole); setCaps([]); }}>
            {roles.map((r) => <option key={r} value={r}>{t(`dashboard.roles.${r}`)}</option>)}
          </Select>
        )}</Field>
        <CapabilityPicker role={role} value={caps} onChange={setCaps} />
        {staff.length ? (
          <Field label={t('team_ui.link_staff')}>{(fp) => (
            <Select {...fp} value={linkStaff} onChange={(e) => setLinkStaff(e.target.value)}>
              <option value="">{t('catalog_team.members.no_link')}</option>
              {staff.filter((s) => s.is_active || s.id === member.staff_profile_id).map((s) => <option key={s.id} value={s.id}>{pick(s.display_name, s.display_name_en)}</option>)}
            </Select>
          )}</Field>
        ) : null}
      </div>
    </Dialog>
  );
}
