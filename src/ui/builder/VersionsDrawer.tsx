'use client';

import { useState } from 'react';
import { History, RotateCcw, Undo2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, newIdempotencyKey } from '../api';
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

  async function run() {
    if (!confirm) return;
    setBusy(true); setErr(null);
    try {
      if (confirm.kind === 'rollback') {
        const r = await api<{ version_number: number }>(`/api/v1/t/${slug}/builder/versions/${confirm.v.id}/rollback`, { body: {}, idempotencyKey: key });
        toast({ tone: 'ok', text: t('builder.versions.rolled_back', { n: r.version_number }) });
        setKey(newIdempotencyKey());
        onRolledBack();
      } else {
        if (!(await beforeRestore())) throw new Error('save_failed');
        await api(`/api/v1/t/${slug}/builder/versions/${confirm.v.id}/restore-draft`, { body: {} });
        toast({ tone: 'ok', text: t('builder.versions.restored', { n: confirm.v.version_number }) });
        onRestored();
      }
      setConfirm(null);
      void q.refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('builder.versions.title')}>
      {err ? <Alert tone="danger" className="mb-3">{msg(err)}</Alert> : null}
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
