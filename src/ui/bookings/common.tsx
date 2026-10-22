'use client';

import { useCallback } from 'react';
import { DateTime } from 'luxon';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney, formatTime } from '@/shared/format';
import { Badge } from '../components/feedback';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';

export type BookingStatus = 'draft' | 'held' | 'pending_approval' | 'pending_payment' | 'confirmed' | 'checked_in' | 'in_service' | 'completed' | 'expired' | 'cancelled' | 'no_show';
export type BookingAction = 'approve' | 'reject' | 'check_in' | 'start' | 'complete' | 'no_show' | 'cancel';

export const STATUSES: BookingStatus[] = ['held', 'pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'in_service', 'completed', 'cancelled', 'no_show', 'expired'];
export const ACTIVE: BookingStatus[] = ['held', 'pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'in_service'];
export const HOLD_STATUSES: string[] = ['held', 'pending_payment'];
/** Actions an assigned specialist (bookings.manage_assigned) may take; everything else needs bookings.manage. */
export const ASSIGNED_ACTIONS: BookingAction[] = ['check_in', 'start', 'complete', 'no_show'];

export type Segment = { staff_id: string; staff_name: string; starts_at: string; ends_at: string; service_name_ar: string | null; service_name_en: string | null };

/** Row of GET /bookings. Money fields are absent for callers without financial access. */
export type BookingRow = {
  id: string; number: string; status: BookingStatus; starts_at: string; ends_at: string; timezone: string; branch_id: string; hold_expires_at: string | null;
  source: string; customer_name: string; services: string | null; staff_names: string | null; segments: Segment[];
  payment_status?: string; total_minor?: number; paid_minor?: number;
};

export type StaffRow = { id: string; display_name: string; display_name_en: string | null; is_active: boolean; branch_ids: string[]; service_ids: string[] };
export type BranchRow = { id: string; name: string; timezone: string; status: string; is_primary: boolean };

const TONES: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand'> = {
  draft: 'neutral', held: 'warn', pending_approval: 'warn', pending_payment: 'warn', confirmed: 'info', checked_in: 'brand', in_service: 'brand',
  completed: 'ok', expired: 'neutral', cancelled: 'danger', no_show: 'danger',
};

export function BookingStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={TONES[status] ?? 'neutral'}>{t(`booking.status.${status}`)}</Badge>;
}

export function PaymentStatusBadge({ status }: { status?: string }) {
  const { t } = useI18n();
  if (!status) return null;
  const tone = status === 'paid' ? 'ok' : status === 'unpaid' ? 'neutral' : status.includes('refund') ? 'warn' : 'info';
  return <Badge tone={tone}>{t(`booking.payment_status.${status}`)}</Badge>;
}

/** Formatting in the booking's own (branch) timezone. */
export function useBookingFmt() {
  const { locale, timeFormat } = useI18n();
  const access = useAccess();
  const money = useCallback((minor: number | null | undefined) => formatMoney(minor, access.currency, locale), [access.currency, locale]);
  const when = useCallback((v: string, tz?: string) => formatDateTime(v, { tz: tz ?? access.timezone, locale, timeFormat }), [access.timezone, locale, timeFormat]);
  const time = useCallback((v: string, tz?: string) => formatTime(v, { tz: tz ?? access.timezone, locale, timeFormat }), [access.timezone, locale, timeFormat]);
  const day = useCallback((v: string | DateTime, tz?: string) => {
    const d = typeof v === 'string' ? DateTime.fromISO(v, { zone: tz ?? access.timezone }) : v;
    return d.setLocale(locale).toFormat('ccc d LLL');
  }, [access.timezone, locale]);
  return { money, when, time, day, locale, timeFormat };
}

/** Team list for filters/columns (only for roles that may list staff). */
export function useStaffList() {
  const access = useAccess();
  const allowed = access.can('staff.edit', 'schedule.manage', 'bookings.view_all', 'bookings.manage', 'catalog.edit');
  return useApiQuery<StaffRow[]>(['staff', access.slug], allowed ? access.api('/staff') : null);
}

export function useBranches() {
  const access = useAccess();
  const allowed = access.can('business.manage', 'schedule.manage', 'bookings.view_all', 'bookings.manage');
  return useApiQuery<{ items: BranchRow[] }>(['branches', access.slug], allowed ? access.api('/branches') : null);
}

/** Who may see amounts on bookings (mirrors the server; fields are also absent when not allowed). */
export function useFinancialAccess() {
  const access = useAccess();
  return access.can('bookings.view_financial', 'bookings.manage', 'payments.collect', 'finance.view');
}

/** Parses a Postgres tstzrange literal such as `["2026-10-22 00:00:00+00","2026-10-23 00:00:00+00")`. */
export function parseRange(r: string): { from: string; to: string } | null {
  const m = /^[[(]"?([^",]+)"?,"?([^",)\]]+)"?[)\]]$/.exec(r.trim());
  if (!m) return null;
  const iso = (s: string) => {
    const d = new Date(s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const from = iso(m[1]!), to = iso(m[2]!);
  return from && to ? { from, to } : null;
}

/** Translation with a fallback for open-ended server values (event sources, reasons, methods). */
export function useLabel() {
  const { t } = useI18n();
  return useCallback((key: string, fallback: string) => { const v = t(key); return v === key ? fallback : v; }, [t]);
}
