'use client';

import { useState } from 'react';
import { History, RotateCcw, Undo2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError, newIdempotencyKey } from '../api';
import type { Issue, RefWarning } from './types';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { formatDateTime } from '@/shared/format';

type Version = { id: string; version_number: number; note: string | null; published_at: string; published_by_name: string | null; is_live: boolean; restored_from_version_number: number | null };

/** Published versions: roll back (republish design only) or restore into the draft (no publish). */
export function VersionsDrawer({ open, onClose, slug, canPublish, beforeRestore, onRestored, onRolledBack }: {
  open: boolean; onClose: () => void; slug: string; canPublish: boolean; beforeRestore: () => Promise<boolean>; onRestored: () => void; onRolledBack: () => void;
}) {
  const { t, locale, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const q = useApiQuery<Version[]>(['builder-versions', slug], open ? `/api/v1/t/${slug}/builder/versions` : null);
  const [confirm, setConfirm] = useState<{ kind: 'rollback' | 'restore'; v: Version } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [key, setKey] = useState(newIdempotencyKey());
  // Reference/capability findings for the last rollback/restore (LUMA-AUDIT-031).
  const [notes, setNotes] = useState<{ warnings: RefWarning[]; issues: Issue[] } | null>(null);
  const describe = (x: { code: string; kind?: string; message?: string }) => {
    if (x.kind) return t(`builder.warnings.codes.${x.code}`, { kind: t(`builder.warnings.kinds.${x.kind}`) });
    const k = `errors.${x.code}`;
    const v = t(k);
    return v === k ? x.message ?? x.code : v;
  };

  async function run() {
    if (!confirm) return;
    setBusy(true); setErr(null); setNotes(null);
    try {
      if (confirm.kind === 'rollback') {
        const r = await api<{ version_number: number; warnings?: RefWarning[] }>(`/api/v1/t/${slug}/builder/versions/${confirm.v.id}/rollback`, { body: {}, idempotencyKey: key });
        toast({ tone: 'ok', text: t('builder.versions.rolled_back', { n: r.version_number }) });
        setKey(newIdempotencyKey());
        if (r.warnings?.length) setNotes({ warnings: r.warnings, issues: [] });
        onRolledBack();
      } else {
        if (!(await beforeRestore())) throw new Error('save_failed');
        const r = await api<{ warnings?: RefWarning[]; issues?: Issue[] }>(`/api/v1/t/${slug}/builder/versions/${confirm.v.id}/restore-draft`, { body: {} });
        if (r.warnings?.length || r.issues?.length) setNotes({ warnings: r.warnings ?? [], issues: r.issues ?? [] });
        toast({ tone: 'ok', text: t('builder.versions.restored', { n: confirm.v.version_number }) });
        onRestored();
      }
      setConfirm(null);
      void q.refetch();
    } catch (e) {
      setErr(e);
      if (e instanceof ApiError && Array.isArray(e.details?.issues)) setNotes({ warnings: [], issues: e.details.issues as Issue[] });
    } finally { setBusy(false); }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('builder.versions.title')}>
      {err ? <Alert tone="danger" className="mb-3">{msg(err)}</Alert> : null}
      {notes ? (
        <Alert tone={notes.issues.length ? 'danger' : 'warn'} className="mb-3">
          <p className="font-medium">{notes.issues.length && err ? t('builder.versions.blocked') : t('builder.versions.notices', { n: notes.issues.length + notes.warnings.length })}</p>
          <ul className="mt-1 list-disc ps-4 text-sm">
            {[...notes.issues, ...notes.warnings].slice(0, 10).map((x, i) => <li key={i}>{describe(x as { code: string; kind?: string; message?: string })}</li>)}
          </ul>
        </Alert>
      ) : null}
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={<History className="size-8" />} title={t('builder.versions.empty')} hint={t('builder.versions.empty_hint')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {q.data.map((v) => (
            <li key={v.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{t('builder.versions.v', { n: v.version_number })}</span>
                {v.is_live ? <Badge tone="ok">{t('builder.versions.live')}</Badge> : null}
                {v.restored_from_version_number ? <Badge tone="info">{t('builder.versions.from', { n: v.restored_from_version_number })}</Badge> : null}
              </div>
              <p className="text-xs text-ink-muted">{formatDateTime(v.published_at, { locale, timeFormat })}{v.published_by_name ? ` · ${v.published_by_name}` : ''}</p>
              {v.note ? <p className="mt-1 text-sm">{v.note}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {!v.is_live && canPublish ? <Button size="sm" variant="outline" icon={<RotateCcw className="size-4" />} onClick={() => setConfirm({ kind: 'rollback', v })}>{t('builder.versions.rollback')}</Button> : null}
                <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setConfirm({ kind: 'restore', v })}>{t('builder.versions.restore')}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} loading={busy} onConfirm={run}
        title={confirm?.kind === 'rollback' ? t('builder.versions.rollback_confirm', { n: confirm.v.version_number }) : t('builder.versions.restore_confirm', { n: confirm?.v.version_number ?? 0 })}
        body={confirm?.kind === 'rollback' ? t('builder.versions.rollback_body') : t('builder.versions.restore_body')} />
    </Drawer>
  );
}
