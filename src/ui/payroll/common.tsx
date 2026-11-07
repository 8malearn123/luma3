'use client';

import { useState } from 'react';
import { DateTime } from 'luxon';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { IconButton } from '../components/button';
import { Input } from '../components/form';
import { useAccess } from '../shell/access-context';

export type EntryKind = 'bonus' | 'deduction' | 'advance' | 'tip';
export type SheetRow = {
  id?: string; number?: string; staff_id: string; staff_name: string;
  base_minor: number; commission_minor: number; commission_count: number; tips_minor: number; bonus_minor: number; deduction_minor: number; advance_minor: number; net_minor: number;
  entries: Array<{ id?: string; kind: EntryKind; amount_minor: number; effective_on: string; note: string | null }>;
  paid_at?: string | null; paid_reference?: string | null;
};
export type Sheet = {
  month: string; status: 'open' | 'closed'; timezone: string; currency: string;
  run: { id: string; closed_at: string; staff_count: number } | null;
  rows: SheetRow[];
  totals: { base_minor: number; commission_minor: number; tips_minor: number; bonus_minor: number; deduction_minor: number; advance_minor: number; net_minor: number; paid_minor: number };
  carried_from?: string | null;
  close: { allowed: boolean; blocker: string | null; expected_month: string | null };
  latest_closed_month: string | null;
};

export const KIND_TONE: Record<EntryKind, 'ok' | 'warn' | 'danger' | 'info'> = { bonus: 'ok', tip: 'info', deduction: 'danger', advance: 'warn' };
export const NEGATIVE: EntryKind[] = ['deduction', 'advance'];

export function useMonth() {
  const access = useAccess();
  return useState(() => DateTime.now().setZone(access.timezone).toFormat('yyyy-MM'));
}

/** Month label in the user's language, e.g. «نوفمبر 2026». */
export function useMonthLabel() {
  const { locale } = useI18n();
  return (month: string) => DateTime.fromISO(`${month}-01`).setLocale(locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en').toFormat('LLLL yyyy');
}

export function MonthPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const { t, locale } = useI18n();
  const label = useMonthLabel();
  const shift = (n: number) => onChange(DateTime.fromISO(`${value}-01`).plus({ months: n }).toFormat('yyyy-MM'));
  const Prev = locale === 'ar' ? ChevronRight : ChevronLeft;
  const Next = locale === 'ar' ? ChevronLeft : ChevronRight;
  return (
    <div className="flex items-center gap-2">
      <IconButton label={t('payroll.month.prev')} onClick={() => shift(-1)}><Prev className="size-4" aria-hidden /></IconButton>
      <span className="w-44 shrink-0"><Input type="month" aria-label={t('payroll.month.label')} value={value} onChange={(e) => e.target.value && onChange(e.target.value)} /></span>
      <IconButton label={t('payroll.month.next')} onClick={() => shift(1)}><Next className="size-4" aria-hidden /></IconButton>
      <span className="hidden whitespace-nowrap text-sm font-medium text-ink-muted sm:inline">{label(value)}</span>
    </div>
  );
}

export const percent = (bp: number | null | undefined) => (bp == null ? '' : String(Number((bp / 100).toFixed(2))));
