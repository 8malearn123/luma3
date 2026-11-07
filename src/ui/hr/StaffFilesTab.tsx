'use client';

import { useRef, useState } from 'react';
import { Eye, FileText, FolderLock, Trash2, Upload } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { todayIn } from '../catalog/common';
import { useDay } from './common';

type Summary = { staff_id: string; staff_name: string; is_active: boolean; employee_number: string | null; nationality: string | null; id_type: string | null; id_expiry: string | null; hire_date: string | null; next_document_expiry: string | null; document_count: number };
type Doc = { id: string; title: string; mime: string; bytes: number; expires_on: string | null; created_at: string; url: string };
type StaffFile = {
  staff_id: string; staff_name: string; employee_number: string | null; nationality: string | null; residence: string | null; id_type: string | null;
  id_number_masked: string | null; has_id_number: boolean; id_expiry: string | null; hire_date: string | null; admin_notes: string | null; documents: Doc[];
};

/** Days until a date in the business timezone (negative = past). */
function useDaysLeft() {
  const access = useAccess();
  const today = todayIn(access.timezone);
  return (d: string | null) => (d ? Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null);
}

function ExpiryBadge({ date }: { date: string | null }) {
  const { t } = useI18n();
  const left = useDaysLeft()(date);
  const day = useDay();
  if (!date || left == null) return <span className="text-ink-muted">—</span>;
  if (left < 0) return <Badge tone="danger">{t('hr.files.expired', { date: day(date) })}</Badge>;
  if (left <= 60) return <Badge tone={left <= 7 ? 'danger' : 'warn'}>{t('hr.files.expires_in', { n: left })}</Badge>;
  return <span>{day(date)}</span>;
}

/** Team → Staff files (owner only). */
export function StaffFilesTab({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const day = useDay();
  const q = useApiQuery<Summary[]>(['hr-files', access.slug], access.api('/hr/staff-files'));
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" title={t('hr.files.owner_only_title')}>{t('hr.files.owner_only')}</Alert>
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={<FolderLock className="size-8" aria-hidden />} title={t('states.empty')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {q.data.map((s) => (
            <li key={s.staff_id}>
              <button type="button" onClick={() => onOpen(s.staff_id)} className="flex w-full flex-col gap-2 rounded-2xl border border-line bg-white p-4 text-start shadow-sm hover:border-luma-300">
                <span className="flex items-center justify-between gap-2"><span className="font-medium">{s.staff_name}</span>{s.employee_number ? <span dir="ltr" className="text-xs text-ink-muted">{s.employee_number}</span> : null}</span>
                <span className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <span className="text-ink-muted">{t('hr.files.hire_date')}</span><span>{s.hire_date ? day(s.hire_date) : '—'}</span>
                  <span className="text-ink-muted">{s.id_type ? t(`hr.files.id_types.${s.id_type}`) : t('hr.files.id_expiry')}</span><span><ExpiryBadge date={s.id_expiry} /></span>
                  <span className="text-ink-muted">{t('hr.files.documents_n', { n: s.document_count })}</span><span><ExpiryBadge date={s.next_document_expiry} /></span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {openId ? <FileDrawer key={openId} staffId={openId} onClose={() => onOpen(null)} onSaved={() => q.refetch()} /> : null}
    </div>
  );
}

function FileDrawer({ staffId, onClose, onSaved }: { staffId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const q = useApiQuery<StaffFile>(['hr-file', access.slug, staffId], access.api(`/hr/staff-files/${staffId}`));
  return (
    <Drawer open onClose={onClose} title={q.data ? t('hr.files.title_for', { name: q.data.staff_name }) : t('hr.files.title')} wide>
      {q.isLoading ? <LoadingState rows={5} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? (
        <div className="flex flex-col gap-6">
          <FileForm key={JSON.stringify(q.data)} file={q.data} onSaved={() => { q.refetch(); onSaved(); }} />
          <Documents file={q.data} onChanged={() => { q.refetch(); onSaved(); }} />
        </div>
      ) : null}
    </Drawer>
  );
}

function FileForm({ file, onSaved }: { file: StaffFile; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const [f, setF] = useState({
    employee_number: file.employee_number ?? '', nationality: file.nationality ?? '', residence: file.residence ?? '', id_type: file.id_type ?? '',
    id_number: '', id_expiry: file.id_expiry ?? '', hire_date: file.hire_date ?? '', admin_notes: file.admin_notes ?? '',
  });
  const [dirty, setDirty] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  useUnsavedChangesWarning(dirty);
  const set = (k: keyof typeof f) => (v: string) => { setF({ ...f, [k]: v }); setDirty(true); };
  const lock = access.readOnly;
  const save = useApiMutation(() => api(access.api(`/hr/staff-files/${file.staff_id}`), {
    method: 'PUT', body: {
      employee_number: f.employee_number.trim() || null, nationality: f.nationality.trim() || null, residence: f.residence.trim() || null,
      id_type: f.id_type || null, ...(f.id_number.trim() ? { id_number: f.id_number.trim() } : {}), id_expiry: f.id_expiry || null,
      hire_date: f.hire_date || null, admin_notes: f.admin_notes.trim() || null,
    },
  }), { onSuccess: () => { setDirty(false); toast({ tone: 'ok', text: t('states.saved') }); onSaved(); } });
  const reveal = useApiMutation(() => api<{ id_number: string }>(access.api(`/hr/staff-files/${file.staff_id}/reveal`), { body: {} }), { onSuccess: (r) => setRevealed(r.id_number) });
  const idValid = !f.id_number.trim() || /^[A-Za-z0-9-]{4,30}$/.test(f.id_number.trim());
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (idValid) save.mutate(undefined); }}>
      <div className="sm:col-span-2"><FormErrorSummary message={save.error ? msg(save.error) : null} /></div>
      <Field label={t('hr.files.employee_number')}>{(p) => <Input {...p} dir="ltr" maxLength={40} disabled={lock} value={f.employee_number} onChange={(e) => set('employee_number')(e.target.value)} />}</Field>
      <Field label={t('hr.files.hire_date')} hint={t('hr.files.hire_hint')}>{(p) => <Input {...p} type="date" dir="ltr" disabled={lock} value={f.hire_date} onChange={(e) => set('hire_date')(e.target.value)} />}</Field>
      <Field label={t('hr.files.nationality')}>{(p) => <Input {...p} maxLength={60} disabled={lock} value={f.nationality} onChange={(e) => set('nationality')(e.target.value)} />}</Field>
      <Field label={t('hr.files.residence')}>{(p) => <Input {...p} maxLength={200} disabled={lock} value={f.residence} onChange={(e) => set('residence')(e.target.value)} />}</Field>
      <Field label={t('hr.files.id_type')}>{(p) => (
        <Select {...p} disabled={lock} value={f.id_type} onChange={(e) => set('id_type')(e.target.value)}>
          <option value="">—</option>
          {(['national_id', 'iqama', 'border_number'] as const).map((k) => <option key={k} value={k}>{t(`hr.files.id_types.${k}`)}</option>)}
        </Select>
      )}</Field>
      <Field label={t('hr.files.id_number')} hint={file.has_id_number ? t('hr.files.id_number_hint') : undefined} error={idValid ? null : t('hr.files.id_number_invalid')}>{(p) => (
        <div className="flex items-center gap-2">
          <Input {...p} dir="ltr" maxLength={30} autoComplete="off" disabled={lock} placeholder={revealed ?? file.id_number_masked ?? ''} value={f.id_number} onChange={(e) => set('id_number')(e.target.value)} />
          {file.has_id_number && !revealed ? <IconButton label={t('hr.files.reveal')} onClick={() => reveal.mutate(undefined)}><Eye className="size-4" aria-hidden /></IconButton> : null}
        </div>
      )}</Field>
      {revealed ? <p className="text-xs text-ink-muted sm:col-span-2"><span dir="ltr" className="font-medium text-ink">{revealed}</span> · {t('hr.files.revealed_note')}</p> : null}
      <Field label={t('hr.files.id_expiry')}>{(p) => <Input {...p} type="date" dir="ltr" disabled={lock} value={f.id_expiry} onChange={(e) => set('id_expiry')(e.target.value)} />}</Field>
      <div className="self-end pb-2"><ExpiryBadge date={f.id_expiry || null} /></div>
      <Field label={t('hr.files.admin_notes')} hint={t('hr.files.admin_notes_hint')} className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} maxLength={4000} disabled={lock} value={f.admin_notes} onChange={(e) => set('admin_notes')(e.target.value)} />}</Field>
      {!lock ? <div className="sm:col-span-2"><Button type="submit" disabled={!dirty || !idValid} loading={save.isPending}>{t('actions.save')}</Button></div> : null}
    </form>
  );
}

function Documents({ file, onChanged }: { file: StaffFile; onChanged: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [expires, setExpires] = useState('');
  const [picked, setPicked] = useState<File | null>(null);
  const upload = useApiMutation(() => {
    const form = new FormData();
    form.set('file', picked!);
    form.set('title', title.trim());
    if (expires) form.set('expires_on', expires);
    return api(access.api(`/hr/staff-files/${file.staff_id}/documents`), { form });
  }, { onSuccess: () => { setTitle(''); setExpires(''); setPicked(null); if (input.current) input.current.value = ''; toast({ tone: 'ok', text: t('hr.files.uploaded') }); onChanged(); } });
  const del = useApiMutation((id: string) => api(access.api(`/hr/staff-files/${file.staff_id}/documents/${id}`), { method: 'DELETE' }), { onSuccess: () => onChanged() });
  return (
    <section>
      <h3 className="mb-2 font-semibold">{t('hr.files.documents')}</h3>
      {!file.documents.length ? <p className="text-sm text-ink-muted">{t('hr.files.no_documents')}</p> : (
        <ul className="mb-3 divide-y divide-line rounded-xl border border-line">
          {file.documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <FileText className="size-4 text-luma-700" aria-hidden />
              <a href={d.url} target="_blank" rel="noreferrer" className="font-medium text-luma-700 hover:underline">{d.title}</a>
              <span className="ms-auto"><ExpiryBadge date={d.expires_on} /></span>
              {!access.readOnly ? <IconButton label={t('actions.delete')} onClick={() => del.mutate(d.id)}><Trash2 className="size-4" aria-hidden /></IconButton> : null}
            </li>
          ))}
        </ul>
      )}
      {del.error ? <p className="text-xs text-danger">{msg(del.error)}</p> : null}
      {!access.readOnly ? (
        <div className="grid gap-2 rounded-xl border border-dashed border-line p-3 sm:grid-cols-2">
          <FormErrorSummary message={upload.error ? msg(upload.error) : null} />
          <Field label={t('hr.files.doc_title')} required className="sm:col-span-2">{(p) => <Input {...p} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <Field label={t('hr.files.doc_expiry')} hint={t('fields.optional')}>{(p) => <Input {...p} type="date" dir="ltr" value={expires} onChange={(e) => setExpires(e.target.value)} />}</Field>
          <Field label={t('hr.files.doc_file')} hint={t('hr.files.doc_file_hint')} required>{(p) => <input {...p} ref={input} type="file" accept="application/pdf,image/*" className="text-sm" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />}</Field>
          <div className="sm:col-span-2"><Button icon={<Upload className="size-4" />} disabled={!picked || !title.trim()} loading={upload.isPending} onClick={() => upload.mutate(undefined)}>{t('hr.files.upload')}</Button></div>
        </div>
      ) : null}
      <p className="mt-2 text-xs text-ink-muted">{t('hr.files.alerts_note')}</p>
    </section>
  );
}
