'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, MapPin, Plus, RotateCcw, Star, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { WEEKDAYS, formatClock } from '@/shared/format';
import { api } from '../api';
import { useApiQuery, useUnsavedChangesWarning } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, Input } from '../components/form';
import { Card } from '../components/layout';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { SectionErrors } from './shared';

type Hour = { weekday: number; opens: string; closes: string };
type Branch = { id: string; name: string; city: string | null; address: string | null; latitude: number | null; longitude: number | null; timezone: string; phone: string | null; is_primary: boolean; status: string; version: number; hours: Hour[] };
type List = { items: Branch[]; limit: number | null; active: number };

export function BranchesSection({ slug, canManage }: { slug: string; canManage: boolean }) {
  const { t, locale, timeFormat } = useI18n();
  const q = useApiQuery<List>(['branches', slug], `/api/v1/t/${slug}/branches`);
  const [edit, setEdit] = useState<Branch | 'new' | null>(null);
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const atLimit = d.limit !== null && d.active >= d.limit;
  return (
    <Card title={t('biz_settings.branches.title')} actions={canManage ? <Button size="sm" icon={<Plus className="size-4" />} disabled={atLimit} onClick={() => setEdit('new')}>{t('biz_settings.branches.add')}</Button> : null}>
      <p className="mb-3 text-sm text-ink-muted">{t('biz_settings.branches.usage', { used: d.active, limit: d.limit ?? t('site.unlimited') })}</p>
      {atLimit && canManage ? <Alert tone="info" className="mb-3">{t('biz_settings.branches.at_limit')}</Alert> : null}
      {!d.items.length ? <EmptyState /> : (
        <ul className="flex flex-col gap-2">
          {d.items.map((b) => (
            <li key={b.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="flex items-center gap-1.5 font-medium"><MapPin className="size-4 text-luma-500" aria-hidden />{b.name}
                    {b.is_primary ? <Badge tone="brand"><Star className="size-3" />{t('biz_settings.branches.primary')}</Badge> : null}
                    {b.status === 'archived' ? <Badge>{t('biz_settings.branches.archived')}</Badge> : null}</p>
                  <p className="text-xs text-ink-muted">{[b.city, b.address].filter(Boolean).map((x) => `${x} · `).join('')}<span dir="ltr">{b.timezone}</span></p>
                </div>
                {canManage ? <Button size="sm" variant="outline" onClick={() => setEdit(b)}>{t('actions.edit')}</Button> : null}
              </div>
              {b.hours.length ? (
                <ul className="mt-2 grid gap-x-4 text-xs text-ink-muted sm:grid-cols-2">
                  {[0, 1, 2, 3, 4, 5, 6].filter((w) => b.hours.some((h) => h.weekday === w)).map((w) => (
                    <li key={w}><span className="font-medium text-ink">{WEEKDAYS[locale][w]}</span>: {b.hours.filter((h) => h.weekday === w).map((h) => `${formatClock(h.opens, locale, timeFormat)}–${formatClock(h.closes, locale, timeFormat)}`).join('، ')}</li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-xs text-warn">{t('biz_settings.branches.no_hours')}</p>}
            </li>
          ))}
        </ul>
      )}
      {edit ? <BranchEditor slug={slug} branch={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
    </Card>
  );
}

function BranchEditor({ slug, branch, onClose }: { slug: string; branch: Branch | null; onClose: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: branch?.name ?? '', city: branch?.city ?? '', address: branch?.address ?? '', phone: branch?.phone ?? '', timezone: branch?.timezone ?? 'Asia/Riyadh',
    latitude: branch?.latitude?.toString() ?? '', longitude: branch?.longitude?.toString() ?? '', hours: branch?.hours ?? [] as Hour[],
  });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<'archive' | null>(null);
  useUnsavedChangesWarning(dirty);
  const set = (p: Partial<typeof f>) => { setF((x) => ({ ...x, ...p })); setDirty(true); };
  const setHour = (i: number, p: Partial<Hour>) => set({ hours: f.hours.map((h, j) => (j === i ? { ...h, ...p } : h)) });

  async function send(body: Record<string, unknown>) {
    setBusy(true); setErr(null);
    try {
      const r = branch
        ? await api<{ future_bookings?: number }>(`/api/v1/t/${slug}/branches/${branch.id}`, { method: 'PATCH', body: { version: branch.version, ...body } })
        : await api(`/api/v1/t/${slug}/branches`, { body });
      setDirty(false);
      toast({ tone: 'ok', text: (r as { future_bookings?: number })?.future_bookings ? t('biz_settings.branches.archived_with_bookings', { n: (r as { future_bookings: number }).future_bookings }) : t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['branches', slug] });
      await qc.invalidateQueries({ queryKey: ['subscription', slug] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); setConfirm(null); }
  }
  const payload = () => ({
    name: f.name, city: f.city || null, address: f.address || null, phone: f.phone || null, timezone: f.timezone,
    latitude: f.latitude === '' ? null : Number(f.latitude), longitude: f.longitude === '' ? null : Number(f.longitude),
    hours: f.hours.filter((h) => h.opens && h.closes),
  });

  return (
    <Drawer open onClose={onClose} wide title={branch ? branch.name : t('biz_settings.branches.add')}
      footer={<>
        {branch && branch.status === 'active' && !branch.is_primary ? <Button variant="ghost" icon={<Star className="size-4" />} loading={busy} onClick={() => send({ is_primary: true })}>{t('biz_settings.branches.make_primary')}</Button> : null}
        {branch && branch.status === 'active' && !branch.is_primary ? <Button variant="outline" icon={<Archive className="size-4" />} onClick={() => setConfirm('archive')}>{t('actions.archive')}</Button> : null}
        {branch && branch.status === 'archived' ? <Button variant="outline" icon={<RotateCcw className="size-4" />} loading={busy} onClick={() => send({ status: 'active' })}>{t('actions.restore')}</Button> : null}
        <Button loading={busy} disabled={!dirty || !f.name.trim()} onClick={() => send(payload())}>{t('actions.save')}</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <SectionErrors err={err} onReload={() => { qc.invalidateQueries({ queryKey: ['branches', slug] }); onClose(); }} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.name')} required>{(p) => <Input {...p} value={f.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />}</Field>
          <Field label={t('biz_settings.profile.city')}>{(p) => <Input {...p} value={f.city} onChange={(e) => set({ city: e.target.value })} />}</Field>
          <Field label={t('biz_settings.branches.address')} className="sm:col-span-2">{(p) => <Input {...p} value={f.address} onChange={(e) => set({ address: e.target.value })} />}</Field>
          <Field label={t('fields.phone')}>{(p) => <Input {...p} dir="ltr" inputMode="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />}</Field>
          <Field label={t('biz_settings.profile.timezone')} hint={t('biz_settings.branches.tz_hint')}>{(p) => <Input {...p} dir="ltr" value={f.timezone} onChange={(e) => set({ timezone: e.target.value })} />}</Field>
          <Field label={t('biz_settings.branches.latitude')}>{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={f.latitude} onChange={(e) => set({ latitude: e.target.value })} />}</Field>
          <Field label={t('biz_settings.branches.longitude')}>{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={f.longitude} onChange={(e) => set({ longitude: e.target.value })} />}</Field>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t('biz_settings.branches.hours')}</h3>
            <Button size="sm" variant="outline" icon={<Plus className="size-4" />} onClick={() => set({ hours: [...f.hours, { weekday: 0, opens: '10:00', closes: '22:00' }] })}>{t('biz_settings.branches.add_range')}</Button>
          </div>
          <p className="mb-2 text-xs text-ink-muted">{t('biz_settings.branches.hours_hint')}</p>
          {f.hours.length ? (
            <ul className="flex flex-col gap-2">
              {f.hours.map((h, i) => (
                <li key={i} className="flex flex-wrap items-end gap-2">
                  <Field label={t('biz_settings.branches.day')} className="w-36">{(p) => (
                    <select {...p} value={h.weekday} onChange={(e) => setHour(i, { weekday: Number(e.target.value) })} className="h-10 w-full rounded-lg border border-line bg-white px-2 text-sm">
                      {WEEKDAYS[locale].map((d, w) => <option key={w} value={w}>{d}</option>)}
                    </select>
                  )}</Field>
                  <Field label={t('fields.from')} className="w-32">{(p) => <Input {...p} type="time" value={h.opens} onChange={(e) => setHour(i, { opens: e.target.value })} />}</Field>
                  <Field label={t('fields.to')} className="w-32">{(p) => <Input {...p} type="time" value={h.closes} onChange={(e) => setHour(i, { closes: e.target.value })} />}</Field>
                  <IconButton label={t('actions.delete')} onClick={() => set({ hours: f.hours.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></IconButton>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-muted">{t('biz_settings.branches.no_hours')}</p>}
        </div>
      </div>
      <ConfirmDialog open={confirm === 'archive'} onClose={() => setConfirm(null)} onConfirm={() => send({ status: 'archived' })} loading={busy}
        title={t('biz_settings.branches.archive_title')} body={t('biz_settings.branches.archive_body')} confirmLabel={t('actions.archive')} danger />
    </Drawer>
  );
}
