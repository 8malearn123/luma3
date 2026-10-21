'use client';

import { useState } from 'react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Archive, ArrowDown, ArrowUp, Check, Eye, EyeOff, FolderTree, Pencil, Plus, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, type ApiError } from '../api';
import { Button, IconButton } from '../components/button';
import { LocalizedInput } from '../components/form';
import { Badge, ErrorState, LoadingState } from '../components/feedback';
import { ConfirmDialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { ApiErrorBox } from './common';

export type Category = { id: string; name_ar: string | null; name_en: string | null; is_visible: boolean; sort: number };

/** Service categories: create, rename, show/hide, reorder (buttons, no dragging) and archive. */
export function CategoriesPanel({ categories, canEdit }: { categories: UseQueryResult<Category[], ApiError>; canEdit: boolean }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState<{ ar?: string; en?: string }>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState<{ ar?: string; en?: string }>({});
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const rows = categories.data ?? [];

  async function run(fn: () => Promise<unknown>, done?: () => void) {
    setBusy(true); setErr(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['categories', access.slug] });
      done?.();
      toast({ tone: 'ok', text: t('states.saved') });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const move = (i: number, d: -1 | 1) => {
    const ids = rows.map((r) => r.id); const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    run(() => api(access.api('/reorder'), { body: { entity: 'categories', ids } }));
  };

  return (
    <details className="group rounded-2xl border border-line bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4">
        <span className="inline-flex items-center gap-2 font-semibold"><FolderTree className="size-4 text-luma-500" aria-hidden />{t('catalog_ui.categories')}
          <span className="rounded-full bg-luma-100 px-1.5 text-xs font-normal">{rows.length}</span></span>
        <span className="text-xs text-ink-muted group-open:hidden">{t('catalog_team.categories.expand')}</span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-line p-4">
        <ApiErrorBox err={err} />
        {categories.isLoading ? <LoadingState rows={2} /> : categories.error ? <ErrorState error={categories.error} onRetry={() => categories.refetch()} /> : (
          rows.length ? (
            <ul className="flex flex-col divide-y divide-line">
              {rows.map((c, i) => (
                <li key={c.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center">
                  {editing === c.id ? (
                    <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="flex-1"><LocalizedInput label={t('fields.name')} value={editName} onChange={setEditName} maxLength={160} /></div>
                      <div className="flex gap-1">
                        <IconButton label={t('actions.save')} disabled={busy || !(editName.ar || editName.en)} onClick={() => run(() => api(access.api(`/categories/${c.id}`), { method: 'PATCH', body: { name_ar: editName.ar || null, name_en: editName.en || null } }), () => setEditing(null))}><Check className="size-4" /></IconButton>
                        <IconButton label={t('actions.cancel')} onClick={() => setEditing(null)}><X className="size-4" /></IconButton>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate font-medium">{pick(c.name_ar, c.name_en)}</span>
                        {!c.is_visible ? <Badge>{t('fields.hidden')}</Badge> : null}
                      </span>
                      {canEdit ? (
                        <span className="flex flex-wrap items-center gap-0.5">
                          <IconButton label={t('actions.move_up')} disabled={busy || i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></IconButton>
                          <IconButton label={t('actions.move_down')} disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></IconButton>
                          <IconButton label={t('catalog_team.categories.rename')} onClick={() => { setEditing(c.id); setEditName({ ar: c.name_ar ?? '', en: c.name_en ?? '' }); }}><Pencil className="size-4" /></IconButton>
                          <IconButton label={c.is_visible ? t('actions.hide') : t('actions.show')} disabled={busy}
                            onClick={() => run(() => api(access.api(`/categories/${c.id}`), { method: 'PATCH', body: { is_visible: !c.is_visible } }))}>
                            {c.is_visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                          </IconButton>
                          <IconButton label={t('actions.archive')} disabled={busy} onClick={() => setArchiveId(c.id)}><Archive className="size-4" /></IconButton>
                        </span>
                      ) : null}
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-muted">{t('catalog_team.categories.empty')}</p>
        )}
        {canEdit ? (adding ? (
          <div className="flex flex-col gap-2 rounded-xl bg-luma-50/60 p-3 sm:flex-row sm:items-end">
            <div className="flex-1"><LocalizedInput label={t('catalog_team.categories.new_name')} required value={name} onChange={setName} maxLength={160} /></div>
            <div className="flex gap-2">
              <Button size="sm" loading={busy} disabled={!(name.ar || name.en)}
                onClick={() => run(() => api(access.api('/categories'), { body: { kind: 'service', name_ar: name.ar || null, name_en: name.en || null } }), () => { setAdding(false); setName({}); })}>{t('actions.add')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('actions.cancel')}</Button>
            </div>
          </div>
        ) : <Button size="sm" variant="outline" className="self-start" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t('catalog_ui.add_category')}</Button>) : null}
      </div>
      <ConfirmDialog open={!!archiveId} onClose={() => setArchiveId(null)} loading={busy} danger title={t('catalog_team.categories.archive_title')}
        body={t('catalog_team.categories.archive_body')} confirmLabel={t('actions.archive')}
        onConfirm={() => run(() => api(access.api(`/categories/${archiveId}`), { method: 'PATCH', body: { archived: true } }), () => setArchiveId(null))} />
    </details>
  );
}
