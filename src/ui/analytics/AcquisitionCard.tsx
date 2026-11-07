'use client';

import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { Card } from '../components/layout';
import { ErrorState, LoadingState } from '../components/feedback';
import { useAccess } from '../shell/access-context';
import { BarList } from './charts';

type Report = { total: number; sources: Array<{ source: string; customers: number; asked: number; visited: number; share_bp: number }> };

/** «كيف عرفتِ عنا؟»: new customers in the period by first-touch acquisition source. */
export function AcquisitionCard({ q }: { q: string }) {
  const { t } = useI18n();
  const access = useAccess();
  const r = useApiQuery<Report>(['analytics', access.slug, 'acquisition', q], access.api(`/analytics/acquisition?${q}`));
  return (
    <Card title={t('customer.acquisition.analytics_title')}>
      {r.isLoading ? <LoadingState rows={3} /> : r.error ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : (
        <>
          <p className="mb-3 text-xs text-ink-muted">{t('customer.acquisition.analytics_hint', { n: r.data!.total })}</p>
          <BarList label={t('customer.acquisition.analytics_title')} empty={t('states.none')}
            items={r.data!.sources.map((s) => ({
              key: s.source, label: t(`customer.acquisition.source.${s.source}`), value: s.customers,
              hint: t('customer.acquisition.analytics_row', { share: (s.share_bp / 100).toFixed(1), visited: s.visited, asked: s.asked }),
            }))} />
        </>
      )}
    </Card>
  );
}
