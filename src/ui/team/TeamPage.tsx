'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarClock, ImageIcon, KeyRound, Plus, Users } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { Button } from '../components/button';
import { Checkbox } from '../components/form';
import { Badge, DeniedState, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { PageHeader, Tabs } from '../components/layout';
import { useAccess } from '../shell/access-context';
import { StepUpProvider } from '../platform/stepup';
import { StaffDrawer } from './StaffDrawer';
import { ScheduleTab } from './ScheduleTab';
import { LeaveTab } from './LeaveTab';
import { AttendanceTab } from './AttendanceTab';
import { MembersTab } from './MembersTab';

export type StaffRow = {
  id: string; display_name: string; display_name_en: string | null; title_ar: string | null; title_en: string | null; bio_ar: string | null; bio_en: string | null;
  photo_asset_id: string | null; is_public: boolean; is_active: boolean; branch_ids: string[]; service_ids: string[]; has_login: boolean;
};

const TABS = ['staff', 'schedule', 'leave', 'attendance', 'members'] as const;
type Tab = (typeof TABS)[number];

/** Which team endpoints this person can read (the server enforces regardless). */
export function useTeamCaps() {
  const access = useAccess();
  return {
    listStaff: access.can('staff.edit', 'schedule.manage', 'bookings.view_all', 'bookings.manage', 'catalog.edit'),
    editStaff: access.can('staff.edit') && !access.readOnly,
    schedule: access.can('schedule.manage') || (access.can('schedule.view_own') && !!access.staffProfileId),
    manageSchedule: access.can('schedule.manage') && !access.readOnly,
    leave: access.can('leave.approve', 'schedule.manage', 'leave.request'),
    attendance: access.can('attendance.manage') || (access.can('attendance.own') && !!access.staffProfileId),
    members: access.can('team.manage'),
  };
}

export function TeamPage() {
  return <StepUpProvider><TeamPageInner /></StepUpProvider>;
}

function TeamPageInner() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const caps = useTeamCaps();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const visible = TABS.filter((k) => (k === 'staff' ? caps.listStaff : caps[k]));
  const tab: Tab | undefined = (visible as readonly string[]).includes(sp.get('tab') ?? '') ? (sp.get('tab') as Tab) : visible[0];
  const open = sp.get('staff');
  const setParams = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) u.set(k, v); else u.delete(k); }
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  };
  const staff = useApiQuery<StaffRow[]>(['staff', access.slug], caps.listStaff ? access.api('/staff') : null);
  const [showInactive, setShowInactive] = useState(false);
  const limit = access.plan.features['limit.staff']?.limit as number | null | undefined;

  if (!tab) return <DeniedState />;
  const rows = (staff.data ?? []).filter((s) => showInactive || s.is_active);

  return (
    <div>
      <PageHeader title={t('team_ui.title')} subtitle={t('catalog_team.team.subtitle')}
        actions={tab === 'staff' && caps.editStaff ? <Button icon={<Plus className="size-4" />} onClick={() => setParams({ staff: 'new' })}>{t('team_ui.new_staff')}</Button> : null} />
      <Tabs value={tab} onChange={(v) => setParams({ tab: v, staff: null, sched: null, invite: null })} items={visible.map((v) => ({
        value: v,
        label: v === 'staff' ? t('team_ui.staff') : v === 'schedule' ? t('team_ui.schedule') : v === 'leave' ? t('team_ui.leave') : v === 'attendance' ? t('catalog_team.attendance.tab') : t('catalog_team.members.tab'),
      }))} />

      {tab === 'staff' ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Checkbox label={t('catalog_team.team.show_inactive')} checked={showInactive} onChange={setShowInactive} />
            {limit ? <span className="text-xs text-ink-muted">{t('catalog_team.team.limit_note', { limit, n: (staff.data ?? []).filter((s) => s.is_active).length })}</span> : null}
          </div>
          {staff.isLoading ? <LoadingState rows={4} /> : staff.error ? <ErrorState error={staff.error} onRetry={() => staff.refetch()} /> : !rows.length ? (
            <EmptyState icon={<Users className="size-8" aria-hidden />} title={t('catalog_team.team.empty')} hint={t('catalog_team.team.empty_hint')}
              action={caps.editStaff ? <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setParams({ staff: 'new' })}>{t('team_ui.new_staff')}</Button> : undefined} />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {rows.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setParams({ staff: s.id })}
                    className="flex w-full items-start gap-3 rounded-2xl border border-line bg-white p-4 text-start shadow-sm hover:border-luma-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-luma-300">
                    {s.photo_asset_id
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={`/api/v1/media/${s.photo_asset_id}`} alt="" className="size-12 shrink-0 rounded-full border border-line object-cover" />
                      : <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-luma-50"><ImageIcon className="size-5 text-luma-300" aria-hidden /></span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{pick(s.display_name, s.display_name_en)}</span>
                      <span className="block truncate text-xs text-ink-muted">{pick(s.title_ar, s.title_en) || '—'}</span>
                      <span className="mt-2 flex flex-wrap gap-1">
                        {!s.is_active ? <Badge tone="danger">{t('fields.inactive')}</Badge> : null}
                        {s.is_active && !s.is_public ? <Badge>{t('fields.hidden')}</Badge> : null}
                        <Badge tone={s.has_login ? 'ok' : 'neutral'}><KeyRound className="size-3" aria-hidden />{s.has_login ? t('team_ui.has_login') : t('team_ui.no_login')}</Badge>
                        <Badge tone="info">{t('catalog_team.team.n_services', { n: s.service_ids.length })}</Badge>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {tab === 'schedule' ? <ScheduleTab staff={staff.data ?? []} staffLoading={staff.isLoading} initialStaffId={sp.get('sched')} /> : null}
      {tab === 'leave' ? <LeaveTab staff={staff.data ?? []} /> : null}
      {tab === 'attendance' ? <AttendanceTab staff={staff.data ?? []} /> : null}
      {tab === 'members' ? <MembersTab staff={staff.data ?? []} inviteFor={sp.get('invite')} onInviteHandled={() => setParams({ invite: null })} /> : null}

      {open && tab === 'staff' ? (
        <StaffDrawer key={open} staffId={open} row={staff.data?.find((s) => s.id === open)} loading={staff.isLoading}
          onClose={() => setParams({ staff: null })}
          onOpenSchedule={caps.schedule ? (id) => setParams({ staff: null, tab: 'schedule', sched: id }) : undefined}
          onInvite={caps.members ? (id) => setParams({ staff: null, tab: 'members', invite: id }) : undefined} />
      ) : null}
      {tab !== 'staff' && !caps.listStaff && !access.staffProfileId ? <p className="mt-4 inline-flex items-center gap-1 text-xs text-ink-muted"><CalendarClock className="size-3.5" aria-hidden />{t('catalog_team.team.not_linked')}</p> : null}
    </div>
  );
}
