'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Armchair, Check, Pencil, Plus, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Field, Input, LocalizedInput, Select } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { ApiErrorBox, PlanGate } from './common';

type Data = {
  types: Array<{ id: string; name_ar: string | null; name_en: string | null }>;
  resources: Array<{ id: string; branch_id: string; resource_type_id: string; name: string; is_active: boolean }>;
};
type Branch = { id: string; name: string; status: string; is_primary: boolean };

/** Resource types (e.g. "Pedicure chair") and their single-unit resources per branch. */
export function ResourcesTab() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = access.hasFeature('feature.resources');
  const q = useApiQuery<Data>(['resources', access.slug], enabled ? access.api('/resources') : null);
  const branches = useApiQuery<{ items: Branch[] }>(['branches', access.slug], enabled && access.can('business.manage', 'schedule.manage', 'bookings.view_all', 'bookings.manage') ? access.api('/branches') : null);
  const canEdit = access.can('catalog.edit') && !access.readOnly;
  const [typeName, setTypeName] = useState<{ ar?: string; en?: string }>({});
  const [addingType, setAddingType] = useState(false);
  const [newRes, setNewRes] = useState<{ typeId: string; name: string; branch: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const activeBranches = (branches.data?.items ?? []).filter((b) => b.status !== 'archived');
  const branchName = (id: string) => branches.data?.items.find((b) => b.id === id)?.name ?? '';

  async function run(fn: () => Promise<unknown>, done?: () => void) {
    setBusy(true); setErr(null);
    try { await fn(); await qc.invalidateQueries({ queryKey: ['resources', access.slug] }); done?.(); toast({ tone: 'ok', text: t('states.saved') }); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }

  if (!enabled) return <PlanGate feature="feature.resources" />;
  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">{t('catalog_team.resources.hint')}</p>
      <ApiErrorBox err={err} />
      {!data.types.length ? <EmptyState icon={<Armchair className="size-8" aria-hidden />} title={t('catalog_team.resources.empty')} hint={t('catalog_team.resources.empty_hint')} /> : null}
      {data.types.map((rt) => {
        const items = data.resources.filter((r) => r.resource_type_id === rt.id);
        return (
          <Card key={rt.id} title={pick(rt.name_ar, rt.name_en)} actions={<span className="text-xs text-ink-muted">{t('catalog_team.resources.units', { n: items.filter((r) => r.is_active).length })}</span>}>
            {items.length ? (
              <ul className="flex flex-col divide-y divide-line">
                {items.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                    {editing?.id === r.id ? (
                      <>
                        <Input aria-label={t('fields.name')} className="max-w-xs flex-1" maxLength={80} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                        <IconButton label={t('actions.save')} disabled={busy || !editing.name.trim()} onClick={() => run(() => api(access.api(`/resources/${r.id}`), { method: 'PATCH', body: { name: editing.name.trim() } }), () => setEditing(null))}><Check className="size-4" /></IconButton>
                        <IconButton label={t('actions.cancel')} onClick={() => setEditing(null)}><X className="size-4" /></IconButton>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{r.name}</span>
                          {branchName(r.branch_id) ? <span className="ms-2 text-xs text-ink-muted">{branchName(r.branch_id)}</span> : null}
                        </span>
                        {!r.is_active ? <Badge>{t('fields.inactive')}</Badge> : null}
                        {canEdit ? (
                          <>
                            <IconButton label={t('actions.edit')} onClick={() => setEditing({ id: r.id, name: r.name })}><Pencil className="size-4" /></IconButton>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api(access.api(`/resources/${r.id}`), { method: 'PATCH', body: { is_active: !r.is_active } }))}>
                              {r.is_active ? t('catalog_team.services.deactivate') : t('catalog_team.services.reactivate')}
                            </Button>
                          </>
                        ) : null}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-muted">{t('catalog_team.resources.no_units')}</p>}
            {canEdit ? (newRes?.typeId === rt.id ? (
              <div className="mt-3 grid gap-2 rounded-xl bg-luma-50/60 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field label={t('catalog_team.resources.unit_name')} required>{(fp) => <Input {...fp} maxLength={80} placeholder={t('catalog_team.resources.unit_placeholder')} value={newRes.name} onChange={(e) => setNewRes({ ...newRes, name: e.target.value })} />}</Field>
                <Field label={t('fields.branch')} required>{(fp) => (
                  <Select {...fp} value={newRes.branch} onChange={(e) => setNewRes({ ...newRes, branch: e.target.value })}>
                    {activeBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </Select>
                )}</Field>
                <div className="flex gap-2">
                  <Button size="sm" loading={busy} disabled={!newRes.name.trim() || !newRes.branch}
                    onClick={() => run(() => api(access.api('/resources'), { body: { resource_type_id: rt.id, branch_id: newRes.branch, name: newRes.name.trim() } }), () => setNewRes(null))}>{t('actions.add')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setNewRes(null)}>{t('actions.cancel')}</Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="mt-3" icon={<Plus className="size-4" />} disabled={!activeBranches.length}
                onClick={() => setNewRes({ typeId: rt.id, name: '', branch: activeBranches.find((b) => b.is_primary)?.id ?? activeBranches[0]?.id ?? '' })}>{t('catalog_team.resources.add_unit')}</Button>
            )) : null}
          </Card>
        );
      })}
      {canEdit ? (addingType ? (
        <Card title={t('catalog_team.resources.new_type')}>
          <div className="flex flex-col gap-3">
            <LocalizedInput label={t('fields.name')} required maxLength={80} value={typeName} onChange={setTypeName} />
            <div className="flex gap-2">
              <Button size="sm" loading={busy} disabled={!(typeName.ar || typeName.en)}
                onClick={() => run(() => api(access.api('/resource-types'), { body: { ...(typeName.ar ? { name_ar: typeName.ar } : {}), ...(typeName.en ? { name_en: typeName.en } : {}) } }), () => { setAddingType(false); setTypeName({}); })}>{t('actions.create')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAddingType(false)}>{t('actions.cancel')}</Button>
            </div>
          </div>
        </Card>
      ) : <Button variant="outline" className="self-start" icon={<Plus className="size-4" />} onClick={() => setAddingType(true)}>{t('catalog_team.resources.new_type')}</Button>) : null}
    </div>
  );
}
