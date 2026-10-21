'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Clock, Plus, Save } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Checkbox, Field, Input, LocalizedInput, MoneyInput, Select } from '../components/form';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { ImageUpload } from '../workspace/ImageUpload';
import { useFmt } from '../commerce/common';
import { ApiErrorBox, intOrNull, PlanGate } from './common';
import type { Category } from './CategoriesPanel';
import type { ServiceRow } from './ServicesPage';

type Staff = { id: string; display_name: string; display_name_en: string | null; is_active: boolean };
type ResourcesData = { types: Array<{ id: string; name_ar: string | null; name_en: string | null }>; resources: Array<{ id: string; resource_type_id: string; is_active: boolean }> };
type Branch = { id: string; name: string; status: string };
type StaffLink = { on: boolean; price: number | null; duration: string };
type L = { ar?: string; en?: string };

function formFrom(s: ServiceRow | undefined) {
  return {
    name: { ar: s?.name_ar ?? '', en: s?.name_en ?? '' } as L,
    description: { ar: s?.description_ar ?? '', en: s?.description_en ?? '' } as L,
    category_id: s?.category_id ?? '', branch_id: s?.branch_id ?? '',
    price_minor: s?.price_minor ?? null as number | null, price_display: s?.price_display ?? 'fixed',
    cost_minor: s?.cost_minor ?? null as number | null,
    duration: String(s?.duration_min ?? 60), buffer_before: String(s?.buffer_before_min ?? 0), buffer_after: String(s?.buffer_after_min ?? 0),
    image: s?.image_asset_id ?? null as string | null,
    is_active: s?.is_active ?? true, is_visible: s?.is_visible ?? true, bookable_internally_when_hidden: s?.bookable_internally_when_hidden ?? true,
    booking_mode: s?.booking_mode ?? 'individual', requires_manual_approval: s?.requires_manual_approval ?? false,
    min_notice: s?.min_notice_min == null ? '' : String(s.min_notice_min), max_advance: s?.max_advance_days == null ? '' : String(s.max_advance_days),
    staff: Object.fromEntries((s?.staff ?? []).map((x) => [x.staff_id, { on: true, price: x.price_override_minor, duration: x.duration_override_min == null ? '' : String(x.duration_override_min) }])) as Record<string, StaffLink>,
    resources: Object.fromEntries((s?.resources ?? []).map((r) => [r.resource_type_id, r.quantity])) as Record<string, number>,
  };
}
type Form = ReturnType<typeof formFrom>;

export function ServiceDrawer({ serviceId, categories, onClose }: { serviceId: string; categories: Category[]; onClose: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const isNew = serviceId === 'new';
  const q = useApiQuery<ServiceRow>(['service', access.slug, serviceId], isNew ? null : access.api(`/services/${serviceId}`));
  if (!isNew && (q.isLoading || q.error || !q.data)) {
    return (
      <Drawer open onClose={onClose} title={t('catalog_team.services.edit')} wide>
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <LoadingState rows={6} />}
      </Drawer>
    );
  }
  // Remount the form when the stored version changes (after a save or a reload).
  return <ServiceForm key={q.data ? `${q.data.id}:${q.data.version}` : 'new'} service={q.data} categories={categories} onClose={onClose} refetch={() => q.refetch()} />;
}

function ServiceForm({ service, categories, onClose, refetch }: { service: ServiceRow | undefined; categories: Category[]; onClose: () => void; refetch: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const qc = useQueryClient();
  const { money } = useFmt();
  const isNew = !service;
  const canEdit = access.can('catalog.edit');
  const canCost = access.can('costs.view');
  const hasResources = access.hasFeature('feature.resources');
  const staffQ = useApiQuery<Staff[]>(['staff', access.slug], access.api('/staff'));
  const resQ = useApiQuery<ResourcesData>(['resources', access.slug], hasResources ? access.api('/resources') : null);
  const branchQ = useApiQuery<{ items: Branch[] }>(['branches', access.slug], access.can('business.manage', 'schedule.manage', 'bookings.view_all', 'bookings.manage') ? access.api('/branches') : null);
  const proposals = useApiQuery<Array<{ id: string; service_id: string; proposed_price_minor: number; current_price_minor: number }>>(['price-proposals', access.slug, 'proposed'], isNew ? null : access.api('/price-proposals?status=proposed'));
  const [form, setForm] = useState<Form>(() => formFrom(service));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  useUnsavedChangesWarning(dirty);

  const set = (p: Partial<Form>) => { setForm((f) => ({ ...f, ...p })); setDirty(true); };
  const setStaff = (id: string, p: Partial<StaffLink>) => set({ staff: { ...form.staff, [id]: { ...(form.staff[id] ?? { on: false, price: null, duration: '' }), ...p } } });
  const archived = !!service?.archived_at;
  const readOnly = !canEdit || archived || access.readOnly;
  const myPending = (proposals.data ?? []).filter((p) => p.service_id === service?.id);
  const priceNeedsApproval = !isNew && access.role !== 'owner';

  function body() {
    const staff = Object.entries(form.staff).filter(([, v]) => v.on).map(([staff_id, v]) => ({
      staff_id, price_override_minor: v.price ?? null, duration_override_min: intOrNull(v.duration),
    }));
    const resource_requirements = hasResources ? Object.entries(form.resources).filter(([, n]) => n > 0).map(([resource_type_id, quantity]) => ({ resource_type_id, quantity })) : undefined;
    return {
      name_ar: form.name.ar?.trim() || null, name_en: form.name.en?.trim() || null,
      description_ar: form.description.ar?.trim() || null, description_en: form.description.en?.trim() || null,
      category_id: form.category_id || null, branch_id: form.branch_id || null,
      price_minor: form.price_minor ?? -1, price_display: form.price_display,
      duration_min: intOrNull(form.duration) ?? 0, buffer_before_min: intOrNull(form.buffer_before) ?? 0, buffer_after_min: intOrNull(form.buffer_after) ?? 0,
      image_asset_id: form.image, is_active: form.is_active, is_visible: form.is_visible, bookable_internally_when_hidden: form.bookable_internally_when_hidden,
      requires_manual_approval: form.requires_manual_approval,
      min_notice_min: intOrNull(form.min_notice), max_advance_days: intOrNull(form.max_advance),
      ...(canCost ? { cost_minor: form.cost_minor } : {}),
      staff, ...(resource_requirements ? { resource_requirements } : {}),
    };
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (isNew) {
        await api(access.api('/services'), { body: { ...body(), booking_mode: form.booking_mode } });
        setDirty(false);
        toast({ tone: 'ok', text: t('catalog_team.services.created') });
        qc.invalidateQueries({ queryKey: ['services', access.slug] });
        onClose();
        return;
      }
      const r = await api<{ pending_price_proposal_id: string | null }>(access.api(`/services/${service!.id}`), { method: 'PATCH', body: { ...body(), version: service!.version } });
      setDirty(false);
      if (r.pending_price_proposal_id) toast({ tone: 'info', text: t('catalog_ui.proposal_pending') });
      else toast({ tone: 'ok', text: t('states.saved') });
      qc.invalidateQueries({ queryKey: ['services', access.slug] });
      qc.invalidateQueries({ queryKey: ['price-proposals', access.slug] });
      refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  async function reload() {
    setDirty(false); setErr(null);
    refetch();
  }

  async function archive(value: boolean) {
    setBusy(true); setErr(null);
    try {
      await api(access.api(`/services/${service!.id}/archive`), { body: { archived: value } });
      setConfirmArchive(false);
      toast({ tone: 'ok', text: value ? t('catalog_team.services.archived_done') : t('catalog_team.services.restored_done') });
      qc.invalidateQueries({ queryKey: ['services', access.slug] });
      refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const staffRows = (staffQ.data ?? []).filter((s) => s.is_active || form.staff[s.id]?.on);
  const title = isNew ? t('catalog_ui.new_service') : pick(service!.name_ar, service!.name_en);

  return (
    <Drawer open onClose={onClose} wide title={title} footer={readOnly ? undefined : (
      <>
        {!isNew ? <Button variant="ghost" icon={<Archive className="size-4" />} onClick={() => setConfirmArchive(true)}>{t('catalog_ui.archive')}</Button> : null}
        <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
        <Button loading={busy} onClick={save}>{t('actions.save')}</Button>
      </>
    )}>
      <div className="flex flex-col gap-6">
        <ApiErrorBox err={err} onReload={reload} />
        {archived ? (
          <Alert tone="warn" title={t('catalog_team.services.archived_note')}>
            {canEdit && !access.readOnly ? <Button className="mt-2" size="sm" variant="outline" icon={<ArchiveRestore className="size-4" />} loading={busy} onClick={() => archive(false)}>{t('actions.restore')}</Button> : null}
          </Alert>
        ) : null}
        {myPending.length ? (
          <Alert tone="info" title={t('catalog_team.proposals.pending_for_service')}>
            {myPending.map((p) => <p key={p.id}><span dir="ltr">{money(p.current_price_minor)}</span> → <span dir="ltr">{money(p.proposed_price_minor)}</span></p>)}
          </Alert>
        ) : null}

        <fieldset disabled={readOnly} className="flex flex-col gap-4">
          <legend className="mb-2 font-semibold">{t('catalog_team.services.section_basic')}</legend>
          <LocalizedInput label={t('fields.name')} required value={form.name} onChange={(v) => set({ name: v })} />
          <LocalizedInput label={t('fields.description')} multiline maxLength={4000} value={form.description} onChange={(v) => set({ description: v })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('fields.category')}>{(fp) => (
              <Select {...fp} value={form.category_id} onChange={(e) => set({ category_id: e.target.value })}>
                <option value="">{t('catalog_team.services.no_category')}</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{pick(c.name_ar, c.name_en)}</option>)}
              </Select>
            )}</Field>
            {branchQ.data && branchQ.data.items.length > 1 ? (
              <Field label={t('fields.branch')}>{(fp) => (
                <Select {...fp} value={form.branch_id} onChange={(e) => set({ branch_id: e.target.value })}>
                  <option value="">{t('catalog_team.services.all_branches')}</option>
                  {branchQ.data!.items.filter((b) => b.status !== 'archived' || b.id === form.branch_id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              )}</Field>
            ) : null}
          </div>
          <ImageUpload slug={access.slug} purpose="service" value={form.image} onChange={(id) => set({ image: id })} label={t('catalog_team.services.upload_image')} />
        </fieldset>

        <fieldset disabled={readOnly} className="flex flex-col gap-4">
          <legend className="mb-2 font-semibold">{t('catalog_team.services.section_price')}</legend>
          {priceNeedsApproval ? <p className="text-xs text-ink-muted">{t('catalog_team.services.price_approval_note')}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('fields.price')} required>{(fp) => <MoneyInput {...fp} value={form.price_minor} onChange={(m) => set({ price_minor: m })} />}</Field>
            <Field label={t('catalog_ui.price_display')}>{(fp) => (
              <Select {...fp} value={form.price_display} onChange={(e) => set({ price_display: e.target.value as 'fixed' | 'starting_from' })}>
                <option value="fixed">{t('catalog_ui.fixed')}</option>
                <option value="starting_from">{t('catalog_ui.starting_from')}</option>
              </Select>
            )}</Field>
            {canCost ? <Field label={t('catalog_ui.cost')} hint={t('catalog_team.services.cost_hint')}>{(fp) => <MoneyInput {...fp} value={form.cost_minor} onChange={(m) => set({ cost_minor: m })} />}</Field> : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('catalog_team.services.duration_min')} required>{(fp) => <Input {...fp} inputMode="numeric" dir="ltr" value={form.duration} onChange={(e) => set({ duration: e.target.value })} />}</Field>
            <Field label={t('catalog_ui.buffer_before')}>{(fp) => <Input {...fp} inputMode="numeric" dir="ltr" value={form.buffer_before} onChange={(e) => set({ buffer_before: e.target.value })} />}</Field>
            <Field label={t('catalog_ui.buffer_after')}>{(fp) => <Input {...fp} inputMode="numeric" dir="ltr" value={form.buffer_after} onChange={(e) => set({ buffer_after: e.target.value })} />}</Field>
          </div>
        </fieldset>

        <fieldset disabled={readOnly} className="flex flex-col gap-3">
          <legend className="mb-2 font-semibold">{t('catalog_team.services.section_booking')}</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('catalog_ui.booking_mode')} hint={!isNew ? t('catalog_team.services.mode_fixed') : undefined}>{(fp) => (
              <Select {...fp} value={form.booking_mode} disabled={!isNew || readOnly} onChange={(e) => set({ booking_mode: e.target.value as 'individual' | 'group' })}>
                <option value="individual">{t('catalog_ui.individual')}</option>
                <option value="group">{t('catalog_ui.group')}</option>
              </Select>
            )}</Field>
            <Field label={t('catalog_team.services.min_notice')} hint={t('catalog_team.services.use_default')}>{(fp) => <Input {...fp} inputMode="numeric" dir="ltr" value={form.min_notice} onChange={(e) => set({ min_notice: e.target.value })} />}</Field>
            <Field label={t('catalog_team.services.max_advance')} hint={t('catalog_team.services.use_default')}>{(fp) => <Input {...fp} inputMode="numeric" dir="ltr" value={form.max_advance} onChange={(e) => set({ max_advance: e.target.value })} />}</Field>
          </div>
          <Checkbox label={t('catalog_team.services.active')} description={t('catalog_team.services.active_hint')} checked={form.is_active} onChange={(v) => set({ is_active: v })} disabled={readOnly} />
          <Checkbox label={t('catalog_ui.show_in_store')} description={t('catalog_team.services.visible_hint')} checked={form.is_visible} onChange={(v) => set({ is_visible: v })} disabled={readOnly} />
          {!form.is_visible ? <Checkbox label={t('catalog_ui.bookable_hidden')} checked={form.bookable_internally_when_hidden} onChange={(v) => set({ bookable_internally_when_hidden: v })} disabled={readOnly} /> : null}
          <Checkbox label={t('catalog_ui.manual_approval')} description={t('catalog_team.services.approval_hint')} checked={form.requires_manual_approval} onChange={(v) => set({ requires_manual_approval: v })} disabled={readOnly} />
        </fieldset>

        <fieldset disabled={readOnly} className="flex flex-col gap-3">
          <legend className="mb-1 font-semibold">{t('catalog_ui.qualified_staff')}</legend>
          <p className="text-xs text-ink-muted">{t('catalog_team.services.staff_hint')}</p>
          {staffQ.isLoading ? <LoadingState rows={2} /> : staffQ.error ? <ErrorState error={staffQ.error} onRetry={() => staffQ.refetch()} /> : !staffRows.length ? (
            <p className="text-sm text-ink-muted">{t('catalog_team.services.no_staff')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {staffRows.map((s) => {
                const link = form.staff[s.id];
                return (
                  <li key={s.id} className="rounded-xl border border-line p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Checkbox label={pick(s.display_name, s.display_name_en)} checked={!!link?.on} onChange={(v) => setStaff(s.id, { on: v })} disabled={readOnly} />
                      {!s.is_active ? <Badge>{t('fields.inactive')}</Badge> : null}
                    </div>
                    {link?.on ? (
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <Field label={t('catalog_ui.price_override')} hint={t('catalog_team.services.override_hint')}>{(fp) => <MoneyInput {...fp} value={link.price} onChange={(m) => setStaff(s.id, { price: m })} />}</Field>
                        <Field label={t('catalog_ui.duration_override')} hint={t('catalog_team.services.minutes_hint')}>{(fp) => <Input {...fp} inputMode="numeric" dir="ltr" value={link.duration} onChange={(e) => setStaff(s.id, { duration: e.target.value })} />}</Field>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <fieldset disabled={readOnly} className="flex flex-col gap-3">
          <legend className="mb-1 font-semibold">{t('catalog_team.services.section_resources')}</legend>
          {!hasResources ? <PlanGate feature="feature.resources" /> : resQ.isLoading ? <LoadingState rows={1} /> : resQ.error ? <ErrorState error={resQ.error} onRetry={() => resQ.refetch()} /> : !resQ.data?.types.length ? (
            <p className="text-sm text-ink-muted">{t('catalog_team.services.no_resource_types')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {resQ.data.types.map((rt) => {
                const units = resQ.data!.resources.filter((r) => r.resource_type_id === rt.id && r.is_active).length;
                return (
                  <li key={rt.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3">
                    <span className="text-sm"><span className="font-medium">{pick(rt.name_ar, rt.name_en)}</span> <span className="text-xs text-ink-muted">({t('catalog_team.resources.units', { n: units })})</span></span>
                    <Select aria-label={t('catalog_team.services.required_qty', { name: pick(rt.name_ar, rt.name_en) })} className="w-40" value={String(form.resources[rt.id] ?? 0)}
                      onChange={(e) => set({ resources: { ...form.resources, [rt.id]: Number(e.target.value) } })}>
                      <option value="0">{t('catalog_team.services.not_required')}</option>
                      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{t('catalog_team.services.needs_n', { n })}</option>)}
                    </Select>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        {!isNew ? <OptionsSection service={service!} kind="variants" readOnly={readOnly} onChanged={refetch} /> : null}
        {!isNew ? <OptionsSection service={service!} kind="addons" readOnly={readOnly} onChanged={refetch} /> : null}
        {isNew ? <p className="text-xs text-ink-muted">{t('catalog_team.services.options_after_create')}</p> : null}
      </div>
      <ConfirmDialog open={confirmArchive} onClose={() => setConfirmArchive(false)} onConfirm={() => archive(true)} loading={busy} danger
        title={t('catalog_team.services.archive_title')} body={t('catalog_team.services.archive_body')} confirmLabel={t('actions.archive')} />
    </Drawer>
  );
}

type Opt = { id?: string; name: L; price: number | null; duration: string; is_active: boolean };

/** Variants (alternative versions with their own price/duration) or add-ons (extras). Saved one row at a time. */
function OptionsSection({ service, kind, readOnly, onChanged }: { service: ServiceRow; kind: 'variants' | 'addons'; readOnly: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const qc = useQueryClient();
  const source = kind === 'variants' ? service.variants : service.addons;
  const [rows, setRows] = useState<Opt[]>(() => source.map((v) => ({ id: v.id, name: { ar: v.name_ar ?? '', en: v.name_en ?? '' }, price: v.price_minor, duration: String(v.duration_min), is_active: v.is_active })));
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const setRow = (i: number, p: Partial<Opt>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  async function saveRow(i: number, patch?: Partial<Opt>) {
    const r = { ...rows[i]!, ...patch };
    setBusy(i); setErr(null);
    const body = { name_ar: r.name.ar?.trim() || null, name_en: r.name.en?.trim() || null, price_minor: r.price ?? -1, duration_min: intOrNull(r.duration) ?? -1, is_active: r.is_active };
    try {
      if (r.id) await api(access.api(`/${kind}/${r.id}`), { method: 'PATCH', body });
      else {
        const created = await api<{ id: string }>(access.api(`/services/${service.id}/${kind}`), { body });
        setRow(i, { id: created.id });
      }
      if (patch) setRow(i, patch);
      toast({ tone: 'ok', text: t('states.saved') });
      qc.invalidateQueries({ queryKey: ['services', access.slug] });
      onChanged();
    } catch (e) { setErr(e); } finally { setBusy(null); }
  }

  const label = kind === 'variants' ? t('catalog_ui.variants') : t('catalog_ui.addons');
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 font-semibold">{label}</legend>
      <p className="text-xs text-ink-muted">{kind === 'variants' ? t('catalog_team.services.variants_hint') : t('catalog_team.services.addons_hint')}</p>
      <ApiErrorBox err={err} />
      {!rows.length ? <p className="text-sm text-ink-muted">{kind === 'variants' ? t('catalog_team.services.no_variants') : t('catalog_team.services.no_addons')}</p> : null}
      {rows.map((r, i) => (
        <div key={r.id ?? `new-${i}`} className="flex flex-col gap-3 rounded-xl border border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{r.id ? `#${i + 1}` : t('catalog_team.services.new_row')}</span>
            {!r.is_active ? <Badge>{t('fields.inactive')}</Badge> : null}
          </div>
          <fieldset disabled={readOnly} className="flex flex-col gap-3">
            <LocalizedInput label={t('fields.name')} required value={r.name} onChange={(v) => setRow(i, { name: v })} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('fields.price')} required>{(fp) => <MoneyInput {...fp} value={r.price} onChange={(m) => setRow(i, { price: m })} />}</Field>
              <Field label={kind === 'variants' ? t('catalog_team.services.duration_min') : t('catalog_team.services.extra_minutes')}>{(fp) => (
                <div className="relative"><Clock className="pointer-events-none absolute inset-y-0 end-3 my-auto size-4 text-ink-muted" aria-hidden />
                  <Input {...fp} inputMode="numeric" dir="ltr" value={r.duration} onChange={(e) => setRow(i, { duration: e.target.value })} /></div>
              )}</Field>
            </div>
          </fieldset>
          {!readOnly ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Save className="size-4" />} loading={busy === i} disabled={busy !== null} onClick={() => saveRow(i)}>{r.id ? t('actions.save') : t('actions.add')}</Button>
              {r.id ? (
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => saveRow(i, { is_active: !r.is_active })}>{r.is_active ? t('catalog_team.services.deactivate') : t('catalog_team.services.reactivate')}</Button>
              ) : <Button size="sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>{t('actions.cancel')}</Button>}
            </div>
          ) : null}
        </div>
      ))}
      {!readOnly && rows.every((r) => r.id) ? (
        <Button variant="outline" size="sm" icon={<Plus className="size-4" />} className="self-start"
          onClick={() => setRows((rs) => [...rs, { name: {}, price: null, duration: kind === 'variants' ? String(service.duration_min) : '0', is_active: true }])}>
          {kind === 'variants' ? t('catalog_team.services.add_variant') : t('catalog_team.services.add_addon')}
        </Button>
      ) : null}
    </fieldset>
  );
}
