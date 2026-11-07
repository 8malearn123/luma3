'use client';

import { MapPin } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useFmt } from '../commerce/common';
import { Stat } from '../components/layout';

export type BranchFinance = { branch_ids: string[]; booking_value_minor: number; bookings: number; collections_minor: number; expenses_minor: number; discounts_minor: number } | null | undefined;

/** Branch slice of the finance report when the header switcher selects a branch (the ledger stays business-wide). */
export function BranchFinanceCard({ data }: { data: BranchFinance }) {
  const { t } = useI18n();
  const { money } = useFmt();
  if (!data) return null;
  return (
    <section aria-label={t('business.branch.finance_title')} className="rounded-xl border border-luma-200 bg-luma-50 p-3 sm:p-4">
      <h3 className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold"><MapPin className="size-4 text-luma-500" aria-hidden />{t('business.branch.finance_title')}</h3>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label={t('finance.booking_value')} value={money(data.booking_value_minor)} hint={t('business.overview.n_bookings', { n: data.bookings })} />
        <Stat label={t('finance.collections')} value={money(data.collections_minor)} />
        <Stat label={t('finance.expenses')} value={money(data.expenses_minor)} />
        <Stat label={t('finance.discounts')} value={money(data.discounts_minor)} />
      </div>
      <p className="mt-2 text-xs text-ink-muted">{t('business.branch.finance_note')}</p>
    </section>
  );
}
