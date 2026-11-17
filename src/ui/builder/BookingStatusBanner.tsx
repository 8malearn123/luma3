'use client';

import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { Alert } from '../components/feedback';

export type BookingStatus = { live: boolean; bookable_services: number; booking_available: boolean; warn: boolean; services_path: string };

/**
 * Owner note when the published storefront has nothing customers can book
 * (LUMA-AUDIT-017). Renders nothing while loading, on error, or when fine.
 */
export function BookingStatusBanner({ slug, showLink = true }: { slug: string; showLink?: boolean }) {
  const { t } = useI18n();
  const q = useApiQuery<BookingStatus>(['booking-status', slug], `/api/v1/t/${slug}/builder/booking-status`);
  if (!q.data?.warn) return null;
  return (
    <Alert tone="warn" title={t('builder.booking_status.title')}>
      <p>{t('builder.booking_status.body')}</p>
      {showLink ? <a className="mt-1 inline-block font-medium underline" href={q.data.services_path}>{t('builder.booking_status.action')}</a> : null}
    </Alert>
  );
}

/** Extra warning inside the archive confirmation when this is the last bookable service of a live store. */
export function ArchiveImpactNote({ slug, serviceId }: { slug: string; serviceId: string }) {
  const { t } = useI18n();
  const q = useApiQuery<BookingStatus>(['booking-status', slug, serviceId], `/api/v1/t/${slug}/builder/booking-status?exclude_service=${serviceId}`);
  if (!q.data?.warn) return null;
  return <Alert tone="warn" className="mt-3" title={t('builder.booking_status.archive_title')}>{t('builder.booking_status.archive_body')}</Alert>;
}
