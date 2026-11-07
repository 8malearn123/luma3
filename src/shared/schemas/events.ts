import { z } from 'zod';

/** Event bookings («حجوزات المناسبات»): request → quote → deposit → confirmed. */
export const EVENT_OCCASIONS = ['wedding', 'engagement', 'graduation', 'group_makeup', 'party', 'other'] as const;
export const EVENT_STATUSES = ['requested', 'quoted', 'pending_payment', 'confirmed', 'completed', 'declined', 'expired', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const EVENT_LOCATIONS = ['venue', 'studio'] as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const text = (max: number) => z.string().trim().max(max);

export const eventRequestInput = z.object({
  occasion: z.enum(EVENT_OCCASIONS),
  event_date: date,
  start_time: time,
  location_type: z.enum(EVENT_LOCATIONS),
  location_text: text(300).optional().nullable(),
  people_count: z.number().int().min(1).max(500),
  service_ids: z.array(z.string().uuid()).max(20).default([]),
  notes: text(2000).optional().nullable(),
  contact_phone: z.string().trim().regex(/^[+0-9 ()-]{6,30}$/).optional().nullable(),
}).strict().refine((v) => v.location_type !== 'venue' || !!v.location_text?.trim(), { path: ['location_text'], message: 'The venue location is required' });
export type EventRequestInput = z.infer<typeof eventRequestInput>;

export const eventQuoteInput = z.object({
  staff_id: z.string().uuid().optional().nullable(),
  duration_min: z.number().int().min(15).max(1440),
  prep_before_min: z.number().int().min(0).max(600).default(0),
  prep_after_min: z.number().int().min(0).max(600).default(0),
  /** The quoted price; tax is applied with the business's tax settings. */
  price_minor: z.number().int().min(100).max(100_000_000),
  deposit: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('percent'), percent_bp: z.number().int().min(100).max(10000) }).strict(),
    z.object({ mode: z.literal('fixed'), amount_minor: z.number().int().min(100).max(100_000_000) }).strict(),
  ]),
  valid_days: z.number().int().min(1).max(30).optional(),
  note: text(1000).optional().nullable(),
}).strict();
export type EventQuoteInput = z.infer<typeof eventQuoteInput>;

export const eventReasonInput = z.object({ reason: text(500).pipe(z.string().min(3)) }).strict();
export const eventAcceptInput = z.object({ quote_version: z.number().int().min(1) }).strict();
export const eventBalanceInput = z.object({
  amount_minor: z.number().int().min(1).max(100_000_000),
  method: z.enum(['cash', 'pos_terminal']),
  reference: text(100).pipe(z.string().min(1)),
}).strict();

export const eventSettingsInput = z.object({
  enabled: z.boolean().optional(),
  default_deposit_bp: z.number().int().min(0).max(10000).optional(),
  free_cancellation_days: z.number().int().min(0).max(365).optional(),
  quote_validity_days: z.number().int().min(1).max(30).optional(),
  max_people: z.number().int().min(1).max(500).optional(),
  intro_ar: text(1000).optional().nullable(),
  intro_en: text(1000).optional().nullable(),
}).strict();

/** Deposit from a percentage, half-up in integer minor units (same rule as booking deposits). */
export function depositFromPercent(totalMinor: number, bp: number) {
  return Math.min(totalMinor, Math.floor((totalMinor * bp + 5000) / 10000));
}

/**
 * Cancellation policy for event bookings (pure; reads the quote snapshot):
 *  - business or system cancellation: everything paid is refunded;
 *  - customer, at least `free_cancellation_days` before the event: full refund;
 *  - customer, later: the deposit is retained, anything paid above the deposit is refunded.
 */
export function eventCancellationRefund(a: {
  by: 'customer' | 'business' | 'system'; paidMinor: number; refundedMinor: number; depositMinor: number;
  startsAt: Date; now: Date; freeCancellationDays: number;
}): { refundMinor: number; retainedMinor: number; basis: 'business_cancelled' | 'free_window' | 'deposit_retained' | 'nothing_paid' } {
  const net = Math.max(0, a.paidMinor - a.refundedMinor);
  if (net === 0) return { refundMinor: 0, retainedMinor: 0, basis: 'nothing_paid' };
  if (a.by !== 'customer') return { refundMinor: net, retainedMinor: 0, basis: 'business_cancelled' };
  const msLeft = a.startsAt.getTime() - a.now.getTime();
  if (msLeft >= a.freeCancellationDays * 86_400_000) return { refundMinor: net, retainedMinor: 0, basis: 'free_window' };
  const retained = Math.min(net, a.depositMinor);
  return { refundMinor: net - retained, retainedMinor: retained, basis: 'deposit_retained' };
}
