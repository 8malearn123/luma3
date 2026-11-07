'use client';

import { DateTime } from 'luxon';
import { FileText } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { Badge, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { useMonthLabel } from './common';

type Amounts = { base_minor: number; commission_minor: number; commission_count: number; tips_minor: number; bonus_minor: number; deduction_minor: number; advance_minor: number; net_minor: number };
type Earnings = {
  month: string; status: 'open' | 'closed'; currency: string;
  current: (Amounts & { id?: string; paid_at?: string | null }) | null;
  slips: Array<Amounts & { id: string; number: string; month: string; paid_at: string | null }>;
};

/** «أرباحي»: this month's live earnings and her own payslips. */
export function EarningsCard() {
  const { t } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const monthLabel = useMonthLabel();
  const month = DateTime.now().setZone(access.timezone).toFormat('yyyy-MM');
  const q = useApiQuery<Earnings>(['my-earnings', access.slug, month], access.api(`/me/earnings?month=${month}`));
  const c = q.data?.current;
  const line = (label: string, v: number, negative = false) => (
    <div className="flex justify-between py-0.5"><dt className="text-ink-muted">{label}</dt><dd dir="ltr" className={negative && v ? 'text-danger' : ''}>{money(negative ? -v : v)}</dd></div>
  );
  return (
    <Card title={t('payroll.me.title')}>
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{monthLabel(month)}</span>
            <Badge tone={q.data?.status === 'closed' ? 'ok' : 'info'}>{q.data?.status === 'closed' ? t('payroll.sheet.status_closed') : t('payroll.me.so_far')}</Badge>
          </div>
          {c ? (
            <>
              <p className="text-2xl font-semibold" dir="ltr">{money(c.net_minor)}</p>
              <dl className="flex flex-col">
                {line(t('payroll.fields.base'), c.base_minor)}
                {line(`${t('payroll.fields.commission')} (${t('payroll.sheet.n_services', { n: c.commission_count })})`, c.commission_minor)}
                {line(t('payroll.fields.tips'), c.tips_minor)}
                {line(t('payroll.fields.bonus'), c.bonus_minor)}
                {line(t('payroll.fields.deduction'), c.deduction_minor, true)}
                {line(t('payroll.fields.advance'), c.advance_minor, true)}
              </dl>
              {q.data?.status === 'open' ? <p className="text-xs text-ink-muted">{t('payroll.me.draft_note')}</p> : null}
            </>
          ) : <p className="text-ink-muted">{t('payroll.me.nothing')}</p>}
          {q.data?.slips.length ? (
            <div>
              <h3 className="mb-1 text-xs font-semibold text-ink-muted">{t('payroll.me.slips')}</h3>
              <ul className="flex flex-col gap-1">
                {q.data.slips.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <a href={access.api(`/payroll/slips/${s.id}`)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-luma-700 hover:underline">
                      <FileText className="size-3.5" aria-hidden />{monthLabel(s.month)}
                    </a>
                    <span className="flex items-center gap-2"><span dir="ltr">{money(s.net_minor)}</span><Badge tone={s.paid_at ? 'ok' : 'neutral'}>{s.paid_at ? t('payroll.sheet.paid') : t('payroll.sheet.unpaid')}</Badge></span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
