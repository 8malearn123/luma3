'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Alert } from '../components/feedback';

type Status = { vat_configured: boolean; legal_name_configured: boolean; phase: number };

/**
 * Owner-facing ZATCA status (phase 1). Without a VAT number receipts and
 * invoices carry no tax QR — a warning with a link to Legal & tax settings.
 * With one, they are titled «فاتورة ضريبية مبسطة» and carry the TLV QR;
 * phase-2 (integration) compliance is explicitly not claimed.
 */
export function ZatcaNotice({ className }: { className?: string }) {
  const { t } = useI18n();
  const access = useAccess();
  const q = useApiQuery<Status>(['zatca', access.slug], access.can('business.manage', 'finance.view') ? access.api('/finance/zatca') : null);
  if (!q.data) return null;
  if (!q.data.vat_configured) {
    return (
      <Alert tone="warn" title={t('business.zatca.missing_title')} className={className}>
        {t('business.zatca.missing_body')}{' '}
        {access.can('business.manage') ? <Link className="font-medium underline" href={`/app/${access.slug}/settings?tab=legal`}>{t('business.zatca.add_vat')}</Link> : null}
      </Alert>
    );
  }
  return <Alert tone="info" title={t('business.zatca.ok_title')} className={className}>{t('business.zatca.ok_body')}</Alert>;
}
