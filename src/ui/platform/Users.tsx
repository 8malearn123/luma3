'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useDebounced } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, Select } from '../components/form';
import { Card, DataTable, PageHeader } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { PageNav, SearchBox, Toolbar, When, qs } from './common';
import { ReasonDialog } from './Tenants';
import { usePlatform } from './PlatformShell';
import { useStepUp } from './stepup';

const ROLES = ['platform_owner', 'support_admin', 'policy_reviewer', 'technical_admin'] as const;
type Row = { id: string; display_name: string; email: string | null; phone: string | null; status: string; is_demo: boolean; created_at: string; mfa_enabled_at: string | null; verified: boolean; platform_roles: string[]; memberships: number };
type Detail = {
  user: { id: string; display_name: string; email: string | null; phone: string | null; status: string; created_at: string; mfa_enabled_at: string | null; email_verified_at: string | null; phone_verified_at: string | null };
  roles: Array<{ id: string; role: string; granted_at: string; revoked_at: string | null; granted_by_name: string | null }>;
  memberships: Array<{ tenant_id: string; slug: string; name: string; role: string; status: string }>;
};

export function UsersPage() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [adminsOnly, setAdminsOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q);
  const path = `/api/v1/platform/users${qs({ q: dq, platform_only: adminsOnly ? '1' : undefined, page, limit: 25 })}`;
  const list = useApiQuery<{ items: Row[]; total: number }>(['platform', 'users', path], path);
  return (
    <div>
      <PageHeader title={t('platform.users.title')} subtitle={t('platform.users.subtitle')} />
      <Alert tone="info" className="mb-3">{t('platform.users.bootstrap_note')}</Alert>
      <Toolbar>
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} label={t('platform.users.search')} />
        <Checkbox label={t('platform.users.admins_only')} checked={adminsOnly} onChange={(v) => { setAdminsOnly(v); setPage(1); }} />
      </Toolbar>
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data!.items.length ? <EmptyState /> : (
        <>
          <DataTable rows={list.data!.items} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} caption={t('platform.users.title')} columns={[
            { key: 'name', header: t('fields.name'), cell: (r) => <div><p className="font-medium">{r.display_name}</p><p className="text-xs text-ink-muted" dir="ltr">{r.email ?? r.phone}</p></div> },
            { key: 'roles', header: t('platform.users.roles'), cell: (r) => r.platform_roles.length ? <div className="flex flex-wrap gap-1">{r.platform_roles.map((x) => <Badge key={x} tone="brand">{t(`platform.roles.${x}`)}</Badge>)}</div> : <span className="text-ink-muted">—</span> },
            { key: 'mfa', header: t('platform.users.mfa'), cell: (r) => r.platform_roles.length ? (r.mfa_enabled_at ? <Badge tone="ok"><ShieldCheck className="size-3.5" />{t('platform.security.enabled')}</Badge> : <Badge tone="warn">{t('platform.security.disabled')}</Badge>) : '—' },
            { key: 'verified', header: t('platform.users.verified'), className: 'hidden md:table-cell', cell: (r) => r.verified ? t('platform.yes') : t('platform.no') },
            { key: 'memberships', header: t('platform.users.businesses'), className: 'hidden md:table-cell', cell: (r) => r.memberships },
            { key: 'created', header: t('platform.created'), className: 'hidden lg:table-cell', cell: (r) => <When v={r.created_at} time={false} /> },
          ]} />
          <PageNav page={page} total={list.data!.total} limit={25} onPage={setPage} />
        </>
      )}
      {open ? <UserDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function UserDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = usePlatform();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const d = useApiQuery<Detail>(['platform', 'user', id], `/api/v1/platform/users/${id}`);
  const [role, setRole] = useState<string>('support_admin');
  const [dialog, setDialog] = useState<null | { kind: 'grant' | 'revoke'; role: string } | { kind: 'mfa' } | { kind: 'status'; status: 'active' | 'suspended' }>(null);
  const active = d.data?.roles.filter((r) => !r.revoked_at) ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform'] });
  return (
    <Drawer open onClose={onClose} wide title={d.data?.user.display_name ?? t('states.loading')}>
      {d.isLoading ? <LoadingState /> : d.error ? <ErrorState error={d.error} onRetry={() => d.refetch()} /> : d.data ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted" dir="ltr">{d.data.user.email ?? ''} {d.data.user.phone ?? ''}</p>
          <Card title={t('platform.users.roles')}>
            {active.length ? (
              <ul className="divide-y divide-line text-sm">{active.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                  <div><Badge tone="brand">{t(`platform.roles.${r.role}`)}</Badge><p className="mt-1 text-xs text-ink-muted"><When v={r.granted_at} /> · {r.granted_by_name ?? t('platform.users.via_cli')}</p></div>
                  {can('platform.roles.manage') ? <Button size="sm" variant="outline" icon={<UserMinus className="size-4" />} onClick={() => setDialog({ kind: 'revoke', role: r.role })}>{t('platform.users.revoke')}</Button> : null}
                </li>
              ))}</ul>
            ) : <p className="text-sm text-ink-muted">{t('platform.users.no_roles')}</p>}
            {can('platform.roles.manage') ? (
              <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
                <Field label={t('platform.users.add_role')}>{(p) => (
                  <Select {...p} value={role} onChange={(e) => setRole(e.target.value)} className="w-56">
                    {ROLES.filter((r) => !active.some((a) => a.role === r)).map((r) => <option key={r} value={r}>{t(`platform.roles.${r}`)}</option>)}
                  </Select>
                )}</Field>
                <Button icon={<UserPlus className="size-4" />} disabled={active.some((a) => a.role === role)} onClick={() => setDialog({ kind: 'grant', role })}>{t('platform.users.grant')}</Button>
              </div>
            ) : null}
            <p className="mt-2 text-xs text-ink-muted">{t('platform.users.roles_explain')}</p>
          </Card>
          {active.length && can('platform.roles.manage') ? (
            <Card title={t('platform.users.mfa')}>
              <p className="mb-2 text-sm">{d.data.user.mfa_enabled_at ? t('platform.users.mfa_on', {}) : t('platform.users.mfa_off')}</p>
              {d.data.user.mfa_enabled_at ? <Button variant="outline" icon={<KeyRound className="size-4" />} onClick={() => setDialog({ kind: 'mfa' })}>{t('platform.users.mfa_reset')}</Button> : null}
            </Card>
          ) : null}
          <Card title={t('platform.users.account')}>
            <p className="mb-2 text-sm">{t('fields.status')}: <Badge tone={d.data.user.status === 'active' ? 'ok' : 'danger'}>{t(`platform.users.status.${d.data.user.status}`)}</Badge></p>
            {d.data.user.status === 'active' ? <Button variant="danger" size="sm" onClick={() => setDialog({ kind: 'status', status: 'suspended' })}>{t('platform.users.suspend')}</Button> : null}
            {d.data.user.status === 'suspended' ? <Button size="sm" onClick={() => setDialog({ kind: 'status', status: 'active' })}>{t('platform.users.reactivate')}</Button> : null}
          </Card>
          <Card title={t('platform.users.businesses')}>
            {d.data.memberships.length ? <ul className="divide-y divide-line text-sm">{d.data.memberships.map((m) => <li key={m.tenant_id} className="flex justify-between py-2"><span>{m.name} <span className="text-xs text-ink-muted" dir="ltr">/{m.slug}</span></span><span className="text-xs">{t(`roles.${m.role}`)}</span></li>)}</ul> : <p className="text-sm text-ink-muted">{t('states.none')}</p>}
          </Card>
          <ReasonDialog open={!!dialog} danger={dialog?.kind !== 'grant' && !(dialog?.kind === 'status' && dialog.status === 'active')}
            title={!dialog ? '' : dialog.kind === 'mfa' ? t('platform.users.mfa_reset') : dialog.kind === 'status' ? t(dialog.status === 'suspended' ? 'platform.users.suspend' : 'platform.users.reactivate') : dialog.kind === 'grant' ? `${t('platform.users.grant')}: ${t(`platform.roles.${dialog.role}`)}` : `${t('platform.users.revoke')}: ${t(`platform.roles.${dialog.role}`)}`}
            body={dialog?.kind === 'mfa' ? t('platform.users.mfa_reset_body') : dialog?.kind === 'status' && dialog.status === 'suspended' ? t('platform.users.suspend_body') : t('platform.users.stepup_note')}
            onClose={() => setDialog(null)}
            onConfirm={async (reason) => {
              if (!dialog) return;
              if (dialog.kind === 'mfa') await stepUp(() => api(`/api/v1/platform/users/${id}/mfa-reset`, { body: { reason } }));
              else if (dialog.kind === 'status') await stepUp(() => api(`/api/v1/platform/users/${id}/status`, { body: { status: dialog.status, reason } }));
              else await stepUp(() => api(`/api/v1/platform/users/${id}/roles`, { body: { role: dialog.role, action: dialog.kind, reason } }));
              setDialog(null); toast({ tone: 'ok', text: t('states.saved') }); await refresh();
            }} />
        </div>
      ) : null}
    </Drawer>
  );
}
