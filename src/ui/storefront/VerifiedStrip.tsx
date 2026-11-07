import { BadgeCheck } from 'lucide-react';
import { makeT, type Locale } from '@/i18n';

/** "Verified by LUMA" mark on a published storefront (business documents reviewed by LUMA). */
export function VerifiedStrip({ locale }: { locale: Locale }) {
  const t = makeT(locale);
  return (
    <div className="flex justify-center px-4 pt-3">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-sf-border bg-sf-surface px-3 py-1 text-xs text-sf-text" title={t('market.verified_hint')}>
        <BadgeCheck className="size-4 text-sf-primary" aria-hidden />{t('market.verified_by_luma')}
      </span>
    </div>
  );
}
