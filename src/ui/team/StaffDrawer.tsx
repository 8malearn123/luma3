'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, KeyRound, Percent, Power, UserPlus } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Checkbox, LocalizedInput } from '../components/form';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { ImageUpload } from '../workspace/ImageUpload';
import { useFmt } from '../commerce/common';
import { ApiErrorBox } from '../catalog/common';
import type { StaffRow } from './TeamPage';

type L = { ar?: string; en?: string };
type Rule = { id: string; staff_id: string | null; service_id: string | null; kind: 'percent' | 'fixed'; rate_bp: number | null; amount_minor: number | null; effective_from: string; effective_to: string | null; is_active: boolean };
type Member = { id: string; role: string; status: string; staff_profile_id: string | null; user: { display_name: string | null; email: string | null; phone: string | null } | null };

export function StaffDrawer({ staffId, row, loading, onClose, onOpenSchedule, onInvite }: {
  staffId: string; row: StaffRow | undefined; loading: boolean; onClose: () => void; onOpenSchedule?: (id: string) => void; onInvite?: (id: string) => void;
}) {
  const { t } = useI18n();
  const isNew = staffId === 'new';
  if (!isNew && !row) {
    return (
      <Drawer open onClose={onClose} title={t('catalog_team.team.profile')} wide>
        {loading ? <LoadingState rows={5} /> : <Alert tone="warn">{t('catalog_team.team.not_found')}</Alert>}
      </Drawer>
    );
  }
  return <StaffForm row={row} onClose={onClose} onOpenSchedule={onOpenSchedule} onInvite={onInvite} />;
}

function StaffForm({ row, onClose, onOpenSchedule, onInvite }: { row: StaffRow | undefined; onClose: () => void; onOpenSchedule?: (id: string) => void; onInvite?: (id: string) => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const { money } = useFmt();
  const isNew = !row;
  const canEdit = access.can('staff.edit') && !access.readOnly;
  const services = useApiQuery<Array<{ id: string; name_ar: string | null; name_en: string | null; archived_at: string | null }>>(['services', access.slug, ''], access.can('catalog.edit', 'bookings.view_all', 'bookings.manage') ? access.api('/services') : null);
  const branches = useApiQuery<{ items: Array<{ id: string; name: string; status: string }> }>(['branches', access.slug], access.can('business.manage', 'schedule.manage', 'bookings.view_all', 'bookings.manage') ? access.api('/branches') : null);
  const rules = useApiQuery<Rule[]>(['commission-rules', access.slug], !isNew && access.can('finance.view', 'staff.edit') ? access.api('/finance/commission-rules') : null);
  const members = useApiQuery<{ members: Member[] }>(['members', access.slug], !isNew && access.can('team.manage') ? access.api('/members') : null);

  const [name, setName] = useState<L>({ ar: row?.display_name ?? '', en: row?.display_name_en ?? '' });
  const [title, setTitle] = useState<L>({ ar: row?.title_ar ?? '', en: row?.title_en ?? '' });
  const [bio, setBio] = useState<L>({ ar: row?.bio_ar ?? '', en: row?.bio_en ?? '' });
  const [photo, setPhoto] = useState<string | null>(row?.photo_asset_id ?? null);
  const [isPublic, setIsPublic] = useState(row?.is_public ?? true);
  const [branchIds, setBranchIds] = useState<string[]>(row?.branch_ids ?? []);
  const [serviceIds, setServiceIds] = useState<string[]>(row?.service_ids ?? []);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [affected, setAffected] = useState<number | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  useUnsavedChangesWarning(dirty);
  const touch = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setDirty(true); };
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
  const readOnly = !canEdit;
  const activeBranches = (branches.data?.items ?? []).filter((b) => b.status !== 'archived');
  const myRules = (rules.data ?? []).filter((r) => r.is_active && (r.staff_id === row?.id || r.staff_id === null));
  const member = (members.data?.members ?? []).find((m) => m.staff_profile_id === row?.id && m.status !== 'removed');
  const svcName = (id: string | null) => { if (!id) return t('catalog_team.team.all_services'); const s = services.data?.find((x) => x.id === id); return s ? pick(s.name_ar, s.name_en) : '—'; };

  async function save() {
    setBusy(true); setErr(null);
    const body = {
      display_name: name.ar?.trim() || name.en?.trim() || '', display_name_en: name.en?.trim() || null,
      title_ar: title.ar?.trim() || null, title_en: title.en?.trim() || null, bio_ar: bio.ar?.trim() || null, bio_en: bio.en?.trim() || null,
      photo_asset_id: photo, is_public: isPublic,
      ...(branches.data ? { branch_ids: branchIds } : {}),
      ...(services.data ? { service_ids: serviceIds } : {}),
    };
    try {
      if (isNew) await api(access.api('/staff'), { body });
      else await api(access.api(`/staff/${row!.id}`), { method: 'PATCH', body });
      setDirty(false);
      toast({ tone: 'ok', text: isNew ? t('catalog_team.team.created') : t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['staff', access.slug] });
      qc.invalidateQueries({ queryKey: ['services', access.slug] });
      if (isNew) onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  async function setActive(active: boolean) {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ affected_booking_ids: string[] }>(access.api(`/staff/${row!.id}`), { method: 'PATCH', body: { is_active: active } });
      setConfirmOff(false);
      setAffected(r.affected_booking_ids?.length || null);
      toast({ tone: 'ok', text: active ? t('catalog_team.team.activated') : t('catalog_team.team.deactivated') });
      await qc.invalidateQueries({ queryKey: ['staff', access.slug] });
    } catch (e) { setErr(e); setConfirmOff(false); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} wide title={isNew ? t('team_ui.new_staff') : pick(row!.display_name, row!.display_name_en)} footer={readOnly ? undefined : (
      <>
        {!isNew ? (
          <Button variant="ghost" icon={<Power className="size-4" />} loading={busy} onClick={() => (row!.is_active ? setConfirmOff(true) : setActive(true))}>
            {row!.is_active ? t('team_ui.deactivate') : t('team_ui.activate')}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
        <Button loading={busy} disabled={!(name.ar?.trim() || name.en?.trim())} onClick={save}>{t('actions.save')}</Button>
      </>
    )}>
      <div className="flex flex-col gap-6">
        <ApiErrorBox err={err} />
        {affected ? <Alert tone="warn" title={t('team_ui.future_bookings_alert', { n: affected })}>{t('catalog_team.team.reassign_hint')}</Alert> : null}
        {!isNew && !row!.is_active ? <Alert tone="warn">{t('catalog_team.team.inactive_note')}</Alert> : null}

        {!isNew ? (
          <div className="flex flex-wrap gap-2">
            {onOpenSchedule ? <Button size="sm" variant="outline" icon={<CalendarClock className="size-4" />} onClick={() => onOpenSchedule(row!.id)}>{t('team_ui.schedule')}</Button> : null}
          </div>
        ) : null}

        <fieldset disabled={readOnly} className="flex flex-col gap-4">
          <legend className="mb-2 font-semibold">{t('catalog_team.team.section_profile')}</legend>
          <LocalizedInput label={t('fields.name')} required maxLength={120} value={name} onChange={touch(setName)} />
          <LocalizedInput label={t('team_ui.title_field')} maxLength={120} value={title} onChange={touch(setTitle)} />
          <LocalizedInput label={t('team_ui.bio')} multiline maxLength={2000} value={bio} onChange={touch(setBio)} />
          <ImageUpload slug={access.slug} purpose="staff" value={photo} onChange={touch(setPhoto)} label={t('catalog_team.team.photo')} />
          <Checkbox label={t('team_ui.public_profile')} description={t('catalog_team.team.public_hint')} checked={isPublic} onChange={touch(setIsPublic)} disabled={readOnly} />
          {activeBranches.length > 1 ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t('catalog_team.team.branches')}</span>
              {activeBranches.map((b) => <Checkbox key={b.id} label={b.name} checked={branchIds.includes(b.id)} onChange={(on) => { setBranchIds(toggle(branchIds, b.id, on)); setDirty(true); }} disabled={readOnly} />)}
            </div>
          ) : null}
        </fieldset>

        <fieldset disabled={readOnly} className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">{t('catalog_team.team.services_performed')}</legend>
          <p className="text-xs text-ink-muted">{t('catalog_team.team.services_hint')}</p>
          {services.isLoading ? <LoadingState rows={2} /> : services.error ? <ErrorState error={services.error} onRetry={() => services.refetch()} /> : !services.data ? null : !services.data.length ? (
            <p className="text-sm text-ink-muted">{t('catalog_ui.no_services')}</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {services.data.filter((s) => !s.archived_at || serviceIds.includes(s.id)).map((s) => (
                <Checkbox key={s.id} label={pick(s.name_ar, s.name_en)} checked={serviceIds.includes(s.id)} onChange={(on) => { setServiceIds(toggle(serviceIds, s.id, on)); setDirty(true); }} disabled={readOnly} />
              ))}
            </div>
          )}
        </fieldset>

        {!isNew && rules.data ? (
          <section className="flex flex-col gap-2">
            <h3 className="inline-flex items-center gap-2 font-semibold"><Percent className="size-4 text-luma-500" aria-hidden />{t('catalog_team.team.commission')}</h3>
            {myRules.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {myRules.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
                    <span className="font-medium" dir="ltr">{r.kind === 'percent' ? `${(r.rate_bp ?? 0) / 100}%` : money(r.amount_minor)}</span>
                    <span className="text-ink-muted">{svcName(r.service_id)}</span>
                    {r.staff_id === null ? <Badge>{t('catalog_team.team.rule_everyone')}</Badge> : null}
                    <span className="text-xs text-ink-muted" dir="ltr">{r.effective_from}{r.effective_to ? ` → ${r.effective_to}` : ''}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-muted">{t('catalog_team.team.no_commission')}</p>}
            <p className="text-xs text-ink-muted">{t('catalog_team.team.commission_note')}</p>
          </section>
        ) : null}

        {!isNew ? (
          <section className="flex flex-col gap-2">
            <h3 className="inline-flex items-center gap-2 font-semibold"><KeyRound className="size-4 text-luma-500" aria-hidden />{t('catalog_team.team.login')}</h3>
            {member ? (
              <p className="text-sm">
                <span className="font-medium">{member.user?.display_name ?? '—'}</span>
                <span className="ms-2 text-ink-muted" dir="ltr">{member.user?.email ?? member.user?.phone ?? ''}</span>
                <Badge className="ms-2">{t(`dashboard.roles.${member.role}`)}</Badge>
              </p>
            ) : row!.has_login ? <p className="text-sm">{t('team_ui.has_login')}</p> : (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-ink-muted">{t('catalog_team.team.no_login_hint')}</p>
                {onInvite ? <Button size="sm" variant="outline" icon={<UserPlus className="size-4" />} onClick={() => onInvite(row!.id)}>{t('catalog_team.team.invite_login')}</Button> : null}
              </div>
            )}
          </section>
        ) : null}
        {isNew ? <p className="text-xs text-ink-muted">{t('catalog_team.team.after_create_hint')}</p> : null}
      </div>
      <ConfirmDialog open={confirmOff} onClose={() => setConfirmOff(false)} onConfirm={() => setActive(false)} loading={busy} danger
        title={t('catalog_team.team.deactivate_title')} body={t('catalog_team.team.deactivate_body')} confirmLabel={t('team_ui.deactivate')} />
    </Drawer>
  );
}
