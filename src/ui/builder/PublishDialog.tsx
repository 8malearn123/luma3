'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Rocket, TriangleAlert } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Spinner } from '../components/feedback';
import { Drawer } from '../components/overlay';
import { Input } from '../components/form';
import { BLOCKS } from '@/shared/builder/blocks';
import type { BuilderState } from './types';

/**
 * Publish: saves pending edits, re-checks readiness and validation on the
 * server, then publishes with an idempotency key (a retry can never create
 * two versions).
 */
export function PublishDialog({ open, onClose, slug, prepare, canPublish, onPublished }: {
  open: boolean; onClose: () => void; slug: string; canPublish: boolean;
  prepare: () => Promise<BuilderState | null>; onPublished: (r: { version_number: number; first_publish: boolean }) => void;
}) {
  const { t, locale, pick } = useI18n();
  const msg = useErrorMessage();
  const [state, setState] = useState<BuilderState | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const m = useApiMutation((_: void, { idempotencyKey }) => api<{ version_number: number; first_publish: boolean }>(`/api/v1/t/${slug}/builder/publish`, { body: note ? { note } : {}, idempotencyKey }), {
    onSuccess: (r) => { onPublished(r); onClose(); },
  });

  // Mounted only while open: save + re-validate once on open.
  useEffect(() => {
    let live = true;
    prepare().then((s) => { if (live) setState(s); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pageName = (id: string | null) => { const p = state?.pages.find((x) => x.id === id); return p ? pick(p.title_ar, p.title_en) : t('builder.publish.site'); };
  const blockName = (pageId: string | null, blockId: string | null) => {
    const b = state?.pages.find((x) => x.id === pageId)?.blocks.find((x) => x.id === blockId || x.children?.some((c) => c.id === blockId));
    return b ? BLOCKS[b.type]?.label[locale] : null;
  };
  const issues = state?.validation.issues ?? [];
  const warnings = state?.validation.warnings ?? [];
  const ready = !!state?.readiness.ready && issues.length === 0;

  return (
    <Drawer open={open} onClose={onClose} title={t('builder.publish.title')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button icon={<Rocket className="size-4" />} disabled={!ready || !canPublish || loading} loading={m.isPending} onClick={() => m.mutate()}>{t('builder.publish.confirm')}</Button>
    </>}>
      {loading || !state ? <div className="flex items-center gap-2 text-sm"><Spinner />{t('builder.publish.checking')}</div> : (
        <div className="flex flex-col gap-4">
          {!canPublish ? <Alert tone="info">{t('builder.publish.no_permission')}</Alert> : null}
          {m.error ? <Alert tone="danger" title={msg(m.error)}>{m.error.details?.items ? <ul className="list-disc ps-4">{(m.error.details.items as Array<{ key: string }>).map((i) => <li key={i.key}>{t(`onboarding.readiness_items.${i.key}`)}</li>)}</ul> : null}</Alert> : null}
          <section>
            <h3 className="mb-2 font-semibold">{t('onboarding.readiness')}</h3>
            <ul className="flex flex-col gap-1.5 text-sm">
              {state.readiness.items.map((i) => (
                <li key={i.key} className="flex items-center gap-2">
                  {i.ok ? <CheckCircle2 className="size-4 text-ok" aria-hidden /> : <CircleAlert className="size-4 text-danger" aria-hidden />}
                  <span className="flex-1">{t(`onboarding.readiness_items.${i.key}`)}</span>
                  {!i.ok ? <Link href={i.action_path} className="text-xs text-luma-700 underline">{t('builder.publish.fix')}</Link> : null}
                  <span className="sr-only">{i.ok ? t('builder.publish.ok') : t('builder.publish.missing')}</span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="mb-2 font-semibold">{t('builder.publish.validation')}</h3>
            {issues.length ? (
              <ul className="flex flex-col gap-1 text-sm text-danger">
                {issues.slice(0, 30).map((i, k) => <li key={k} className="flex gap-1"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{pageName(i.pageId)}{blockName(i.pageId, i.blockId) ? ` · ${blockName(i.pageId, i.blockId)}` : ''}: {t(`errors.${i.code}`) !== `errors.${i.code}` ? t(`errors.${i.code}`) : i.message}</li>)}
              </ul>
            ) : <p className="flex items-center gap-1 text-sm text-ok"><CheckCircle2 className="size-4" aria-hidden />{t('builder.publish.valid')}</p>}
          </section>
          {warnings.length ? (
            <section>
              <h3 className="mb-2 font-semibold">{t('builder.warnings.title')}</h3>
              <ul className="flex flex-col gap-1 text-sm text-warn">
                {warnings.slice(0, 30).map((w, k) => <li key={k} className="flex gap-1"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{pageName(w.pageId)}{blockName(w.pageId, w.blockId) ? ` · ${blockName(w.pageId, w.blockId)}` : ''}: {t(`builder.warnings.codes.${w.code}`, { kind: t(`builder.warnings.kinds.${w.kind}`) })}</li>)}
              </ul>
              <p className="mt-1 text-xs text-ink-muted">{t('builder.publish.warnings_note')}</p>
            </section>
          ) : null}
          {state.contrast_warnings.length ? <Alert tone="warn">{t('builder.publish.contrast')}</Alert> : null}
          <label className="flex flex-col gap-1 text-sm">{t('builder.publish.note')}<Input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <p className="text-xs text-ink-muted">{t('builder.publish.explain')}</p>
        </div>
      )}
    </Drawer>
  );
}
