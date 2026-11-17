'use client';

import Link from 'next/link';
import { CircleSlash } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { EmptyState } from '../components/feedback';
import { useAccess } from '../shell/access-context';

/**
 * «غير متاح لنشاطك» (LUMA-AUDIT-014): shown when a page is opened by direct
 * URL although the business type does not have it (e.g. hosting for a
 * freelancer, payroll for a solo freelancer). The server refuses the same
 * area's API (workspace-mode.ts); this is only the friendly page.
 */
export function NotAvailable({ area }: { area: 'hosting' | 'groups' | 'payroll' }) {
  const { t } = useI18n();
  const access = useAccess();
  return (
    <div data-testid="not-available">
      <EmptyState icon={<CircleSlash className="size-8" aria-hidden />} title={t('workspace_mode.not_available.title')}
        hint={t(`workspace_mode.not_available.${area}`)}
        action={<Link href={`/app/${access.slug}`} className="text-sm font-medium text-luma-700 underline">{t('workspace_mode.not_available.back')}</Link>} />
    </div>
  );
}
