'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../../hooks';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Card } from '../../components/layout';

type L = { ar: string; en: string };
/** Read-only list of Loom's curated knowledge units (§9) for the platform owner. */
export function LoomKnowledgeList() {
  const { t, locale } = useI18n();
  const q = useApiQuery<any[]>(['platform', 'loom', 'knowledge'], '/api/v1/platform/loom/knowledge');
  const [open, setOpen] = useState<string | null>(null);
  const r = (x: L) => (locale === 'ar' ? x.ar : x.en);
  return (
    <Card title={t('loomp.admin.knowledge_title')}>
      <p className="mb-3 text-sm text-ink-muted">{t('loomp.admin.knowledge_hint')}</p>
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data!.length ? <EmptyState title={t('loomp.admin.knowledge_empty')} /> : (
        <ul className="flex flex-col gap-2">
          {q.data!.map((u) => {
            const key = `${u.id}@${u.version}`;
            return (
              <li key={key} className="rounded-lg border border-line p-3 text-sm">
                <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-start" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                  <span><span className="font-medium" dir="auto">{r(u.title)}</span> <span className="font-mono text-xs text-ink-muted" dir="ltr">{key}</span></span>
                  <span className="flex flex-wrap gap-1.5">
                    {u.sectors.map((s: string) => <Badge key={s} tone="brand">{s}</Badge>)}
                    {u.needs_review ? <Badge tone="warn">{t('loomp.admin.needs_review')}</Badge> : null}
                    {!u.current ? <Badge>{t('loomp.admin.superseded')}</Badge> : null}
                    <Badge>{t('loomp.admin.citations', { n: u.citations })}</Badge>
                  </span>
                </button>
                {open === key ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <p className="sm:col-span-2" dir="auto">{r(u.guidance)}</p>
                    <p dir="auto"><span className="font-medium">{t('loomp.admin.when_not')}:</span> {r(u.when_not_to_use)}</p>
                    <p dir="ltr" className="text-xs"><span className="font-medium">{t('loomp.admin.measurement')}:</span> {u.measurement.primary} · {u.measurement.design}</p>
                    <p className="text-xs" dir="ltr">{t('loomp.admin.scope')}: {[...u.detectors, ...u.interventions].join(', ')}</p>
                    <p className="text-xs" dir="ltr">{t('loomp.admin.source')}: {u.source.type} · {u.source.ref} · {u.reviewed_at} · {u.owner}</p>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
