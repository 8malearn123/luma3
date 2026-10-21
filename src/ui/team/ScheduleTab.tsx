'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Copy, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatClock, formatDate, tzLabel, WEEKDAYS } from '@/shared/format';
import { api, ApiError } from '../api';
import { useApiQuery, useUnsavedChangesWarning } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Field, Input, Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { ConfirmDialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { ApiErrorBox, hhmm, localToIso, parseRange, todayIn } from '../catalog/common';
import { useTeamCaps, type StaffRow } from './TeamPage';

type Range = { start_time: string; end_time: string; label?: string };
type Schedule = {
  staff: { id: string; display_name: string; is_active: boolean };
  hours: Array<{ id: string; branch_id: string; weekday: number; start_time: string; end_time: string }>;
  breaks: Array<{ id: string; weekday: number | null; on_date: string | null; start_time: string; end_time: string; label: string | null }>;
  overrides: Array<{ id: string; branch_id: string; on_date: string; kind: 'off' | 'replace' | 'extra'; start_time: string | null; end_time: string | null; note: string | null }>;
  blocks: Array<{ id: string; branch_id: string; during: string; reason: string | null }>;
};
type Branch = { id: string; name: string; status: string; is_primary: boolean };
type Week = Record<number, { ranges: Range[]; breaks: Range[] }>;

const DAYS = [0, 1, 2, 3, 4, 5, 6];

export function ScheduleTab({ staff, staffLoading, initialStaffId }: { staff: StaffRow[]; staffLoading: boolean; initialStaffId: string | null }) {
  const { t, pick, locale } = useI18n();
  const access = useAccess();
  const caps = useTeamCaps();
  const choices = access.can('schedule.manage') ? staff.filter((s) => s.is_active || s.id === initialStaffId) : [];
  const [staffId, setStaffId] = useState<string>(initialStaffId ?? (access.can('schedule.manage') ? '' : access.staffProfileId ?? ''));
  const effective = staffId || choices[0]?.id || '';
  const branches = useApiQuery<{ items: Branch[] }>(['branches', access.slug], access.can('business.manage', 'schedule.manage', 'bookings.view_all', 'bookings.manage') ? access.api('/branches') : null);
  const activeBranches = (branches.data?.items ?? []).filter((b) => b.status !== 'archived');
  const [branchId, setBranchId] = useState('');
  const branch = branchId || activeBranches.find((b) => b.is_primary)?.id || activeBranches[0]?.id || '';
  const q = useApiQuery<Schedule>(['schedule', access.slug, effective], effective ? access.api(`/staff/${effective}/schedule`) : null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        {access.can('schedule.manage') ? (
          <Field label={t('catalog_team.schedule.staff')} className="sm:w-64">{(fp) => (
            <Select {...fp} value={effective} onChange={(e) => setStaffId(e.target.value)} disabled={staffLoading}>
              {choices.map((s) => <option key={s.id} value={s.id}>{pick(s.display_name, s.display_name_en)}</option>)}
            </Select>
          )}</Field>
        ) : null}
        {activeBranches.length > 1 ? (
          <Field label={t('fields.branch')} className="sm:w-56">{(fp) => (
            <Select {...fp} value={branch} onChange={(e) => setBranchId(e.target.value)}>
              {activeBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          )}</Field>
        ) : null}
        <p className="text-xs text-ink-muted sm:ms-auto">{t('time.tz_note', { tz: tzLabel(access.timezone, locale) })}</p>
      </div>
      {staffLoading && access.can('schedule.manage') ? <LoadingState rows={3} /> : !effective ? (
        <EmptyState title={t('catalog_team.schedule.no_staff')} />
      ) : q.isLoading ? <LoadingState rows={5} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? (
        <>
          {/* Remount the editor when the person, branch or stored data changes. */}
          <WeeklyEditor key={`${effective}:${branch}`} data={q.data} staffId={effective} branchId={branch || q.data.hours[0]?.branch_id || ''} readOnly={!caps.manageSchedule} />
          <OverridesCard data={q.data} staffId={effective} branchId={branch || q.data.hours[0]?.branch_id || ''} readOnly={!caps.manageSchedule} />
          <BlocksCard data={q.data} staffId={effective} branchId={branch || q.data.hours[0]?.branch_id || ''} readOnly={!caps.manageSchedule} />
        </>
      ) : null}
    </div>
  );
}

function weekFrom(data: Schedule, branchId: string): Week {
  const w: Week = Object.fromEntries(DAYS.map((d) => [d, { ranges: [], breaks: [] }]));
  for (const h of data.hours) if (h.branch_id === branchId) w[h.weekday]!.ranges.push({ start_time: hhmm(h.start_time), end_time: hhmm(h.end_time) });
  for (const b of data.breaks) if (b.weekday != null) w[b.weekday]!.breaks.push({ start_time: hhmm(b.start_time), end_time: hhmm(b.end_time), label: b.label ?? '' });
  for (const d of DAYS) w[d]!.ranges.sort((a, b) => a.start_time.localeCompare(b.start_time));
  return w;
}

function validate(week: Week): 'invalid_hours' | 'overlapping_hours' | null {
  for (const d of DAYS) {
    const day = week[d]!;
    for (const r of [...day.ranges, ...day.breaks]) if (!r.start_time || !r.end_time || r.end_time <= r.start_time) return 'invalid_hours';
    const s = [...day.ranges].sort((a, b) => a.start_time.localeCompare(b.start_time));
    for (let i = 1; i < s.length; i++) if (s[i]!.start_time < s[i - 1]!.end_time) return 'overlapping_hours';
  }
  return null;
}

function WeeklyEditor({ data, staffId, branchId, readOnly }: { data: Schedule; staffId: string; branchId: string; readOnly: boolean }) {
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const [week, setWeek] = useState<Week>(() => weekFrom(data, branchId));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [local, setLocal] = useState<string | null>(null);
  useUnsavedChangesWarning(dirty);

  const update = (d: number, kind: 'ranges' | 'breaks', fn: (rs: Range[]) => Range[]) => {
    setWeek((w) => ({ ...w, [d]: { ...w[d]!, [kind]: fn(w[d]![kind]) } }));
    setDirty(true); setLocal(null);
  };
  const copyToAll = (d: number) => {
    setWeek((w) => Object.fromEntries(DAYS.map((x) => [x, { ranges: w[d]!.ranges.map((r) => ({ ...r })), breaks: w[d]!.breaks.map((r) => ({ ...r })) }])) as Week);
    setDirty(true);
  };

  async function save() {
    const v = validate(week);
    if (v) { setLocal(v); return; }
    setBusy(true); setErr(null);
    try {
      await api(access.api(`/staff/${staffId}/schedule`), { method: 'PUT', body: {
        branch_id: branchId,
        ranges: DAYS.flatMap((d) => week[d]!.ranges.map((r) => ({ weekday: d, start_time: r.start_time, end_time: r.end_time }))),
        breaks: DAYS.flatMap((d) => week[d]!.breaks.map((r) => ({ weekday: d, start_time: r.start_time, end_time: r.end_time, ...(r.label?.trim() ? { label: r.label.trim() } : {}) }))),
      } });
      setDirty(false);
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['schedule', access.slug, staffId] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const rangeRow = (d: number, kind: 'ranges' | 'breaks', i: number, r: Range) => (
    <div key={`${kind}${i}`} className="flex flex-wrap items-center gap-2">
      <Input type="time" aria-label={`${WEEKDAYS[locale][d]} ${t('fields.from')}`} className="w-28" dir="ltr" value={r.start_time} disabled={readOnly}
        onChange={(e) => update(d, kind, (rs) => rs.map((x, j) => (j === i ? { ...x, start_time: e.target.value } : x)))} />
      <span className="text-ink-muted">–</span>
      <Input type="time" aria-label={`${WEEKDAYS[locale][d]} ${t('fields.to')}`} className="w-28" dir="ltr" value={r.end_time} disabled={readOnly}
        onChange={(e) => update(d, kind, (rs) => rs.map((x, j) => (j === i ? { ...x, end_time: e.target.value } : x)))} />
      {kind === 'breaks' ? (
        <Input aria-label={t('catalog_team.schedule.break_label')} placeholder={t('catalog_team.schedule.break_label')} className="w-32" maxLength={60} value={r.label ?? ''} disabled={readOnly}
          onChange={(e) => update(d, kind, (rs) => rs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
      ) : null}
      {!readOnly ? <IconButton label={t('actions.delete')} onClick={() => update(d, kind, (rs) => rs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton> : null}
    </div>
  );

  return (
    <Card title={t('team_ui.weekly')} actions={dirty ? <span className="text-xs text-warn">{t('states.unsaved')}</span> : null}>
      <div className="flex flex-col gap-3">
        <ApiErrorBox err={err} />
        {local ? <Alert tone="danger">{t(`errors.${local}`)}</Alert> : null}
        {!branchId ? <Alert tone="warn">{t('catalog_team.schedule.no_branch')}</Alert> : null}
        <ul className="flex flex-col divide-y divide-line">
          {DAYS.map((d) => {
            const day = week[d]!;
            return (
              <li key={d} className="flex flex-col gap-2 py-3 md:flex-row md:items-start">
                <div className="flex items-center justify-between gap-2 md:w-36 md:flex-col md:items-start">
                  <span className="font-medium">{WEEKDAYS[locale][d]}</span>
                  {!day.ranges.length ? <Badge>{t('catalog_team.schedule.off')}</Badge> : null}
                </div>
                <div className="flex flex-1 flex-col gap-2">
                  {day.ranges.map((r, i) => rangeRow(d, 'ranges', i, r))}
                  {day.breaks.length ? <p className="text-xs font-medium text-ink-muted">{t('team_ui.breaks')}</p> : null}
                  {day.breaks.map((r, i) => rangeRow(d, 'breaks', i, r))}
                  {readOnly && day.ranges.length ? (
                    <p className="sr-only">{day.ranges.map((r) => `${formatClock(r.start_time, locale, timeFormat)}–${formatClock(r.end_time, locale, timeFormat)}`).join(', ')}</p>
                  ) : null}
                  {!readOnly ? (
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => update(d, 'ranges', (rs) => [...rs, { start_time: rs.at(-1)?.end_time ?? '10:00', end_time: '18:00' }])}>{t('team_ui.add_range')}</Button>
                      <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} disabled={!day.ranges.length} onClick={() => update(d, 'breaks', (rs) => [...rs, { start_time: '13:00', end_time: '14:00', label: '' }])}>{t('catalog_team.schedule.add_break')}</Button>
                      <Button size="sm" variant="ghost" icon={<Copy className="size-4" />} onClick={() => copyToAll(d)}>{t('catalog_team.schedule.copy_all')}</Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button loading={busy} disabled={!dirty || !branchId} onClick={save}>{t('actions.save')}</Button>
            <span className="text-xs text-ink-muted">{t('catalog_team.schedule.save_note')}</span>
          </div>
        ) : <p className="text-xs text-ink-muted">{t('catalog_team.schedule.read_only')}</p>}
      </div>
    </Card>
  );
}

function OverridesCard({ data, staffId, branchId, readOnly }: { data: Schedule; staffId: string; branchId: string; readOnly: boolean }) {
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ on_date: todayIn(access.timezone, 1), kind: 'off' as 'off' | 'replace' | 'extra', start_time: '10:00', end_time: '18:00', note: '' });
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const today = todayIn(access.timezone);
  const rows = [...data.overrides].sort((a, b) => a.on_date.localeCompare(b.on_date));
  const kindLabel = (k: string) => (k === 'off' ? t('team_ui.day_off') : k === 'replace' ? t('team_ui.replace_hours') : t('team_ui.extra_hours'));

  async function run(fn: () => Promise<unknown>, done: () => void) {
    setBusy(true); setErr(null);
    try { await fn(); done(); toast({ tone: 'ok', text: t('states.saved') }); await qc.invalidateQueries({ queryKey: ['schedule', access.slug, staffId] }); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Card title={t('team_ui.overrides')} actions={!readOnly && !adding ? <Button size="sm" variant="outline" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t('actions.add')}</Button> : null}>
      <div className="flex flex-col gap-3">
        <ApiErrorBox err={err} />
        {adding ? (
          <div className="grid gap-3 rounded-xl bg-luma-50/60 p-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('fields.date')} required>{(fp) => <Input {...fp} type="date" dir="ltr" min={today} value={form.on_date} onChange={(e) => setForm({ ...form, on_date: e.target.value })} />}</Field>
            <Field label={t('catalog_team.schedule.kind')}>{(fp) => (
              <Select {...fp} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}>
                <option value="off">{t('team_ui.day_off')}</option>
                <option value="replace">{t('team_ui.replace_hours')}</option>
                <option value="extra">{t('team_ui.extra_hours')}</option>
              </Select>
            )}</Field>
            {form.kind !== 'off' ? (
              <>
                <Field label={t('fields.from')}>{(fp) => <Input {...fp} type="time" dir="ltr" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />}</Field>
                <Field label={t('fields.to')}>{(fp) => <Input {...fp} type="time" dir="ltr" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />}</Field>
              </>
            ) : null}
            <Field label={t('fields.notes')} className="sm:col-span-2">{(fp) => <Input {...fp} maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
            <div className="flex items-end gap-2 sm:col-span-2">
              <Button size="sm" loading={busy} disabled={!form.on_date || !branchId}
                onClick={() => run(() => api(access.api(`/staff/${staffId}/overrides`), { body: {
                  branch_id: branchId, on_date: form.on_date, kind: form.kind, ...(form.kind !== 'off' ? { start_time: form.start_time, end_time: form.end_time } : {}), ...(form.note.trim() ? { note: form.note.trim() } : {}),
                } }), () => setAdding(false))}>{t('actions.save')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('actions.cancel')}</Button>
            </div>
          </div>
        ) : null}
        {!rows.length ? <p className="text-sm text-ink-muted">{t('catalog_team.schedule.no_overrides')}</p> : (
          <ul className="flex flex-col divide-y divide-line">
            {rows.map((o) => (
              <li key={o.id} className={`flex flex-wrap items-center gap-2 py-2 ${o.on_date < today ? 'opacity-60' : ''}`}>
                <span className="font-medium">{formatDate(`${o.on_date}T12:00:00Z`, { tz: 'UTC', locale, weekday: true })}</span>
                <Badge tone={o.kind === 'off' ? 'warn' : 'info'}>{kindLabel(o.kind)}</Badge>
                {o.start_time && o.end_time ? <span className="text-sm">{formatClock(hhmm(o.start_time), locale, timeFormat)}–{formatClock(hhmm(o.end_time), locale, timeFormat)}</span> : null}
                {o.note ? <span className="text-xs text-ink-muted">{o.note}</span> : null}
                {!readOnly ? <IconButton className="ms-auto" label={t('actions.delete')} onClick={() => setDel(o.id)}><Trash2 className="size-4" /></IconButton> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} loading={busy} danger title={t('catalog_team.schedule.delete_override')} body={t('catalog_team.schedule.delete_override_body')} confirmLabel={t('actions.delete')}
        onConfirm={() => run(() => api(access.api(`/overrides/${del}`), { method: 'DELETE' }), () => setDel(null))} />
    </Card>
  );
}

function BlocksCard({ data, staffId, branchId, readOnly }: { data: Schedule; staffId: string; branchId: string; readOnly: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const { when } = useFmt();
  const tomorrow = todayIn(access.timezone, 1);
  const [form, setForm] = useState({ from: `${tomorrow}T13:00`, to: `${tomorrow}T14:00`, reason: '' });
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [now] = useState(() => Date.now());
  const rows = data.blocks.map((b) => ({ ...b, r: parseRange(b.during) })).filter((b) => b.r).sort((a, b) => a.r!.from.getTime() - b.r!.from.getTime());

  async function run(fn: () => Promise<unknown>, done: () => void) {
    setBusy(true); setErr(null);
    try { await fn(); done(); toast({ tone: 'ok', text: t('states.saved') }); await qc.invalidateQueries({ queryKey: ['schedule', access.slug, staffId] }); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Card title={t('catalog_team.schedule.blocks')} actions={!readOnly && !adding ? <Button size="sm" variant="outline" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t('actions.add')}</Button> : null}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-ink-muted">{t('catalog_team.schedule.blocks_hint')}</p>
        <ApiErrorBox err={err} />
        {adding ? (
          <div className="grid gap-3 rounded-xl bg-luma-50/60 p-3 sm:grid-cols-2">
            <Field label={t('fields.from')} required>{(fp) => <Input {...fp} type="datetime-local" dir="ltr" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
            <Field label={t('fields.to')} required>{(fp) => <Input {...fp} type="datetime-local" dir="ltr" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
            <Field label={t('fields.reason')} className="sm:col-span-2">{(fp) => <Input {...fp} maxLength={200} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}</Field>
            <div className="flex gap-2 sm:col-span-2">
              <Button size="sm" loading={busy} disabled={!branchId}
                onClick={() => {
                  const s = localToIso(form.from, access.timezone), e = localToIso(form.to, access.timezone);
                  if (!s || !e || e <= s) { setErr(new ApiError(422, 'invalid_range', 'invalid_range')); return; }
                  run(() => api(access.api('/time-blocks'), { body: { branch_id: branchId, staff_id: staffId, starts_at: s, ends_at: e, ...(form.reason.trim() ? { reason: form.reason.trim() } : {}) } }), () => setAdding(false));
                }}>{t('actions.save')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('actions.cancel')}</Button>
            </div>
          </div>
        ) : null}
        {!rows.length ? <p className="inline-flex items-center gap-2 text-sm text-ink-muted"><CalendarOff className="size-4" aria-hidden />{t('catalog_team.schedule.no_blocks')}</p> : (
          <ul className="flex flex-col divide-y divide-line">
            {rows.map((b) => (
              <li key={b.id} className={`flex flex-wrap items-center gap-2 py-2 text-sm ${b.r!.to.getTime() < now ? 'opacity-60' : ''}`}>
                <span className="font-medium">{when(b.r!.from)} – {when(b.r!.to)}</span>
                {b.reason ? <span className="text-xs text-ink-muted">{b.reason}</span> : null}
                {!readOnly ? <IconButton className="ms-auto" label={t('actions.delete')} onClick={() => setDel(b.id)}><Trash2 className="size-4" /></IconButton> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} loading={busy} danger title={t('catalog_team.schedule.delete_block')} body={t('catalog_team.schedule.delete_block_body')} confirmLabel={t('actions.delete')}
        onConfirm={() => run(() => api(access.api(`/time-blocks/${del}`), { method: 'DELETE' }), () => setDel(null))} />
    </Card>
  );
}
