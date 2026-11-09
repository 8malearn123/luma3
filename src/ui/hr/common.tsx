'use client';

import { useCallback } from 'react';
import { DateTime } from 'luxon';
import { useI18n } from '@/i18n/client';
import { formatNumber } from '@/shared/format';
import { Badge } from '../components/feedback';

export type Balance = {
  staff_id: string; staff_name?: string; hire_date: string | null; as_of: string; yearly_entitlement: number;
  accrued: number; adjustments: number; taken: number; pending: number; balance: number | null; sick_taken_year: number;
};
export type FieldDef = { key: string; label_ar: string; label_en?: string; type: 'text' | 'number' | 'date' | 'select'; required?: boolean; options?: string[] };
export type RequestType = {
  id: string; code: string; kind: 'leave' | 'advance' | 'letter' | 'other'; leave_type: string | null; name_ar: string; name_en: string | null;
  approval_chain: string[]; fields: FieldDef[]; is_system: boolean; is_active: boolean; sort: number;
};
export type HrRequest = {
  id: string; type_id: string; staff_id: string; staff_name: string; type_code: string; kind: RequestType['kind']; leave_type: string | null;
  type_name_ar: string; type_name_en: string | null; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; current_step: number; approval_chain: string[];
  field_values: Record<string, string | number>; starts_on: string | null; ends_on: string | null; leave_days: number | null; leave_request_id: string | null;
  balance_warning: boolean; amount_minor: number | null; installments: number | null; payroll_entry_id: string | null; note: string | null; created_at: string;
  decided_at: string | null; can_act: boolean; can_cancel: boolean;
};
export type HrAction = { id: string; step: number; role: string | null; action: 'submitted' | 'approved' | 'rejected' | 'cancelled'; note: string | null; data: Record<string, unknown>; created_at: string; actor_role: string | null; actor_name: string | null };
export type DayFlag = { staff_id: string; date: string; scheduled_start: string | null; scheduled_minutes: number; first_in: string | null; late_minutes: number; absent: boolean; on_leave: boolean };

export const STATUS_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = { pending: 'warn', approved: 'ok', rejected: 'danger', cancelled: 'neutral' };
export const CHAIN_ROLES = ['manager', 'owner', 'finance', 'receptionist'] as const;

/** Days with up to two decimals, localized. */
export function useDays() {
  const { locale } = useI18n();
  return useCallback((n: number | null | undefined) => formatNumber(n ?? 0, locale, { maximumFractionDigits: 2 }), [locale]);
}

export function useDay() {
  const { locale } = useI18n();
  return useCallback((iso: string | null | undefined) => (iso ? DateTime.fromISO(iso).setLocale(locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en').toFormat('d LLL yyyy') : '—'), [locale]);
}

export function RequestStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`hr.status.${status}`)}</Badge>;
}

/** "Approval chain: manager → owner", with the current step highlighted. */
export function ChainSteps({ chain, current, status }: { chain: string[]; current?: number; status?: string }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs">
      {chain.map((r, i) => {
        const done = status === 'approved' || (current != null && i < current);
        const here = status === 'pending' && current === i;
        return (
          <span key={`${r}-${i}`} className="inline-flex items-center gap-1">
            {i > 0 ? <span aria-hidden className="text-ink-muted">←</span> : null}
            <span className={here ? 'rounded-md bg-warn-bg px-1.5 py-0.5 font-medium text-warn' : done ? 'rounded-md bg-ok-bg px-1.5 py-0.5 text-ok' : 'rounded-md bg-luma-50 px-1.5 py-0.5 text-ink-muted'}>
              {t(`hr.roles.${r}`)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** Late / absent badge for a day ("تأخير 12 دقيقة"). */
export function DayFlagBadge({ flag }: { flag: DayFlag | undefined }) {
  const { t } = useI18n();
  if (!flag) return null;
  if (flag.absent) return <Badge tone="danger">{t('hr.attendance.absent')}</Badge>;
  if (flag.late_minutes > 0) return <Badge tone="warn">{t('hr.attendance.late', { n: flag.late_minutes })}</Badge>;
  if (flag.on_leave) return <Badge tone="info">{t('hr.attendance.on_leave')}</Badge>;
  return null;
}
