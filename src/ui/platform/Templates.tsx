'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, CheckCircle2, Plus, Undo2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, FormErrorSummary, Input, Select, Switch, Textarea } from '../components/form';
import { DataTable, PageHeader, Tabs } from '../components/layout';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { Toolbar, When } from './common';

type T = { id: string; key: string; name_ar: string; name_en: string; description_ar: string | null; description_en: string | null; business_types: string[]; status: string; version: number; approved_at: string | null; updated_at: string };
type Full = T & { document: unknown };
type Comp = { type: string; label: { ar: string; en: string }; category: string; is_enabled: boolean; min_plan_feature: string | null };

const TYPES = ['salon', 'expert', 'beauty_center', 'spa'];
const STARTER = JSON.stringify({
  layout: { nav_style: 'simple', booking_entry: 'both' },
  pages: [{ kind: 'home', blocks: [
    { id: 'b_hero_001', type: 'hero', schemaVersion: 1, props: { title: { ar: 'مرحباً بكِ', en: 'Welcome' }, overlay: 0.35, align: 'center', height: 'md' }, visibility: { enabled: true }, action: { type: 'start_booking' } },
    { id: 'b_list_001', type: 'service_list', schemaVersion: 1, props: {}, visibility: { enabled: true } },
  ] }],
}, null, 2);

export function TemplatesPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'templates' | 'components'>('templates');
  return (
    <div>
      <PageHeader title={t('platform.templates.title')} subtitle={t('platform.templates.subtitle')} />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'templates', label: t('platform.templates.tab_templates') }, { value: 'components', label: t('platform.templates.tab_components') }]} />
      {tab === 'templates' ? <TemplateList /> : <Components />}
    </div>
  );
}

function TemplateList() {
  const { t, pick } = useI18n();
  const [status, setStatus] = useState('');
  const [edit, setEdit] = useState<string | 'new' | null>(null);
  const q = useApiQuery<T[]>(['platform', 'templates', status], `/api/v1/platform/templates${status ? `?status=${status}` : ''}`);
  return (
    <>
      <Toolbar>
        <Select aria-label={t('fields.status')} className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('platform.all_statuses')}</option>
          {['draft', 'approved', 'retired'].map((s) => <option key={s} value={s}>{t(`platform.templates.status.${s}`)}</option>)}
        </Select>
        <div className="flex-1" />
        <Button icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>{t('platform.templates.new')}</Button>
      </Toolbar>
      <Alert tone="info" className="mb-3">{t('platform.templates.only_approved')}</Alert>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data!.length ? <EmptyState title={t('platform.templates.empty')} /> : (
        <DataTable rows={q.data!} rowKey={(r) => r.id} onRowClick={(r) => setEdit(r.id)} caption={t('platform.templates.title')} columns={[
          { key: 'name', header: t('fields.name'), cell: (r) => <div><p className="font-medium">{pick(r.name_ar, r.name_en)}</p><p className="font-mono text-xs text-ink-muted" dir="ltr">{r.key}</p></div> },
          { key: 'status', header: t('fields.status'), cell: (r) => <Badge tone={r.status === 'approved' ? 'ok' : r.status === 'retired' ? 'neutral' : 'info'}>{t(`platform.templates.status.${r.status}`)}</Badge> },
          { key: 'types', header: t('platform.templates.business_types'), className: 'hidden md:table-cell', cell: (r) => r.business_types.map((b) => t(`onboarding.types.${b}`)).join('، ') },
          { key: 'updated', header: t('platform.templates.updated'), className: 'hidden md:table-cell', cell: (r) => <When v={r.updated_at} /> },
        ]} />
      )}
      {edit ? <TemplateEditor id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
    </>
  );
}

function TemplateEditor({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const d = useApiQuery<Full>(['platform', 'template', id], id ? `/api/v1/platform/templates/${id}` : null);
  if (id && d.isLoading) return <Drawer open onClose={onClose} title={t('states.loading')}><LoadingState /></Drawer>;
  if (id && d.error) return <Drawer open onClose={onClose} title={t('states.error')}><ErrorState error={d.error} /></Drawer>;
  return <TemplateForm initial={id ? d.data! : null} onClose={onClose} />;
}

function TemplateForm({ initial, onClose }: { initial: Full | null; onClose: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    key: initial?.key ?? '', name_ar: initial?.name_ar ?? '', name_en: initial?.name_en ?? '', description_ar: initial?.description_ar ?? '', description_en: initial?.description_en ?? '',
    business_types: initial?.business_types ?? ['salon'], doc: initial ? JSON.stringify(initial.document, null, 2) : STARTER,
  });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [version, setVersion] = useState(initial?.version ?? 1);
  const [status, setStatus] = useState(initial?.status ?? 'draft');
  useUnsavedChangesWarning(dirty);
  const set = (p: Partial<typeof f>) => { setF((x) => ({ ...x, ...p })); setDirty(true); };

  const issues = err instanceof ApiError && err.code === 'invalid_template' ? (err.details?.issues as Array<{ path: string; message: string; page?: number }> ?? []).map((i) => ({ path: `${i.page != null ? `page ${i.page + 1} ` : ''}${i.path}`, message: i.message })) : undefined;

  async function save() {
    setErr(null);
    let document: unknown;
    try { document = JSON.parse(f.doc); } catch { setErr(new ApiError(422, 'invalid_json', t('platform.templates.json_invalid'))); return; }
    setBusy(true);
    try {
      const body = { name_ar: f.name_ar, name_en: f.name_en, description_ar: f.description_ar || null, description_en: f.description_en || null, business_types: f.business_types, document };
      const r = initial
        ? await api<Full>(`/api/v1/platform/templates/${initial.id}`, { method: 'PUT', body: { ...body, version } })
        : await api<Full>('/api/v1/platform/templates', { body: { ...body, key: f.key } });
      setDirty(false); setVersion(r.version); setStatus(r.status);
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform', 'templates'] });
      if (!initial) onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  async function review(next: 'approved' | 'retired' | 'draft') {
    if (!initial) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<Full>(`/api/v1/platform/templates/${initial.id}/status`, { body: { status: next, version } });
      setVersion(r.version); setStatus(r.status);
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform', 'templates'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} wide title={initial ? `${t('actions.edit')}: ${initial.key}` : t('platform.templates.new')}
      footer={<>
        {initial && status !== 'approved' && !dirty ? <Button variant="secondary" icon={<CheckCircle2 className="size-4" />} loading={busy} onClick={() => review('approved')}>{t('platform.templates.approve')}</Button> : null}
        {initial && status === 'approved' ? <Button variant="outline" icon={<Archive className="size-4" />} loading={busy} onClick={() => review('retired')}>{t('platform.templates.retire')}</Button> : null}
        {initial && status === 'retired' ? <Button variant="outline" icon={<Undo2 className="size-4" />} loading={busy} onClick={() => review('draft')}>{t('platform.templates.to_draft')}</Button> : null}
        <Button loading={busy} disabled={!dirty} onClick={save}>{t('actions.save')}</Button>
      </>}>
      <div className="flex flex-col gap-3">
        {initial ? <p className="text-sm">{t('fields.status')}: <Badge tone={status === 'approved' ? 'ok' : 'info'}>{t(`platform.templates.status.${status}`)}</Badge></p> : null}
        {initial && status === 'approved' ? <Alert tone="info">{t('platform.templates.edit_resets')}</Alert> : null}
        <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
        {!initial ? <Field label={t('platform.templates.key')} hint={t('platform.templates.key_hint')} required>{(p) => <Input {...p} dir="ltr" value={f.key} onChange={(e) => set({ key: e.target.value.toLowerCase() })} />}</Field> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.name_ar')} required>{(p) => <Input {...p} dir="rtl" value={f.name_ar} onChange={(e) => set({ name_ar: e.target.value })} />}</Field>
          <Field label={t('fields.name_en')} required>{(p) => <Input {...p} dir="ltr" value={f.name_en} onChange={(e) => set({ name_en: e.target.value })} />}</Field>
          <Field label={`${t('fields.description')} (ع)`}>{(p) => <Textarea {...p} dir="rtl" value={f.description_ar} onChange={(e) => set({ description_ar: e.target.value })} />}</Field>
          <Field label={`${t('fields.description')} (EN)`}>{(p) => <Textarea {...p} dir="ltr" value={f.description_en} onChange={(e) => set({ description_en: e.target.value })} />}</Field>
        </div>
        <fieldset className="flex flex-wrap gap-3"><legend className="mb-1 text-sm font-medium">{t('platform.templates.business_types')}</legend>
          {TYPES.map((b) => <Checkbox key={b} label={t(`onboarding.types.${b}`)} checked={f.business_types.includes(b)} onChange={(v) => set({ business_types: v ? [...f.business_types, b] : f.business_types.filter((x) => x !== b) })} />)}
        </fieldset>
        <Field label={t('platform.templates.document')} hint={t('platform.templates.document_hint')} required>{(p) => <Textarea {...p} dir="ltr" rows={18} className="font-mono text-xs" spellCheck={false} value={f.doc} onChange={(e) => set({ doc: e.target.value })} />}</Field>
      </div>
    </Drawer>
  );
}

function Components() {
  const { t, pick } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const q = useApiQuery<Comp[]>(['platform', 'components'], '/api/v1/platform/builder-components');
  const [err, setErr] = useState<unknown>(null);
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">{t('platform.templates.components_note')}</p>
      <FormErrorSummary message={err ? msg(err) : null} />
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {q.data!.map((c) => (
          <li key={c.type} className="flex items-center justify-between gap-2 rounded-xl border border-line bg-white p-3">
            <div><p className="text-sm font-medium">{pick(c.label.ar, c.label.en)}</p><p className="font-mono text-xs text-ink-muted" dir="ltr">{c.type}{c.min_plan_feature ? ` · ${c.min_plan_feature}` : ''}</p></div>
            <Switch label={<span className="sr-only">{pick(c.label.ar, c.label.en)}</span>} checked={c.is_enabled} onChange={async (v) => {
              setErr(null);
              try { await api(`/api/v1/platform/builder-components/${c.type}`, { method: 'PUT', body: { is_enabled: v, min_plan_feature: c.min_plan_feature } }); await qc.invalidateQueries({ queryKey: ['platform', 'components'] }); }
              catch (e) { setErr(e); }
            }} />
          </li>
        ))}
      </ul>
    </div>
  );
}
