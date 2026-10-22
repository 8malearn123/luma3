'use client';

import { useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { ConfirmDialog, Drawer } from '../components/overlay';

type Template = { id: string; key: string; name_ar: string; name_en: string; description_ar: string | null; description_en: string | null; pages: string[]; valid: boolean; brand: Record<string, unknown>; layout: Record<string, unknown> };

/** LUMA-approved starting layouts. Applying changes the draft structure only — colours, logo and catalog stay yours. */
export function TemplatesDrawer({ open, onClose, slug, beforeApply, onApplied }: { open: boolean; onClose: () => void; slug: string; beforeApply: () => Promise<boolean>; onApplied: () => void }) {
  const { t, pick } = useI18n();
  const msg = useErrorMessage();
  const q = useApiQuery<Template[]>(['builder-templates', slug], open ? `/api/v1/t/${slug}/builder/templates` : null);
  const [confirm, setConfirm] = useState<Template | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Drawer open={open} onClose={onClose} title={t('builder.templates.title')}>
      <p className="mb-3 text-sm text-ink-muted">{t('builder.templates.hint')}</p>
      {err ? <Alert tone="danger" className="mb-3">{msg(err)}</Alert> : null}
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <EmptyState icon={<LayoutTemplate className="size-8" />} title={t('builder.templates.empty')} /> : (
        <ul className="flex flex-col gap-2">
          {q.data.filter((x) => x.valid).map((tp) => (
            <li key={tp.id} className="rounded-xl border border-line p-3">
              <p className="font-semibold">{pick(tp.name_ar, tp.name_en)}</p>
              {pick(tp.description_ar, tp.description_en) ? <p className="text-sm text-ink-muted">{pick(tp.description_ar, tp.description_en)}</p> : null}
              <p className="mt-1 text-xs text-ink-muted">{t('builder.templates.pages', { pages: tp.pages.map((p) => t(`builder.kinds.${p}`)).join('، ') })}</p>
              <Button className="mt-2" size="sm" variant="outline" onClick={() => setConfirm(tp)}>{t('builder.templates.apply')}</Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} loading={busy} title={t('builder.templates.confirm', { name: confirm ? pick(confirm.name_ar, confirm.name_en) : '' })} body={t('builder.templates.confirm_body')}
        onConfirm={async () => {
          if (!confirm) return;
          setBusy(true); setErr(null);
          try {
            if (!(await beforeApply())) throw new Error('save_failed');
            await api(`/api/v1/t/${slug}/builder/templates/${confirm.id}/apply`, { body: {} });
            setConfirm(null); onApplied(); onClose();
          } catch (e) { setErr(e); setConfirm(null); } finally { setBusy(false); }
        }} />
    </Drawer>
  );
}
