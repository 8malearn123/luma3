import { z } from 'zod';

/**
 * Workspace hosting («المساحات والاستضافة» / «احجزي مساحة عمل») — shared
 * contracts and pure pricing rules. Binding decisions:
 * docs/HOSTING_INVENTORY_DECISIONS.md (D1–D14).
 */

// ── Statuses & transitions ──────────────────────────────────────────────────
export const WS_STATUSES = ['draft', 'requested', 'pending_approval', 'held', 'pending_payment', 'confirmed', 'checked_in', 'in_use', 'completed', 'cancelled', 'expired', 'no_show'] as const;
export type WsStatus = (typeof WS_STATUSES)[number];
export type WsActor = 'guest' | 'host' | 'system';

/**
 * Explicit transition table: action → allowed source statuses, target and who
 * may trigger it. The hosting service refuses anything not listed here.
 *  - draft is reserved (not used at launch: a request is submitted directly).
 *  - approval mode (D1): requested → pending_approval (2h hold, D1c) → held (approved, awaiting payment).
 *  - instant mode: requested → held.
 */
export const WS_TRANSITIONS = {
  submit: { from: ['draft'], to: 'requested', by: ['guest'] },
  await_approval: { from: ['requested'], to: 'pending_approval', by: ['system'] },
  hold: { from: ['requested'], to: 'held', by: ['system'] },
  approve: { from: ['pending_approval'], to: 'held', by: ['host'] },
  reject: { from: ['pending_approval'], to: 'cancelled', by: ['host'] },
  checkout: { from: ['held'], to: 'pending_payment', by: ['guest'] },
  payment_captured: { from: ['held', 'pending_payment'], to: 'confirmed', by: ['system'] },
  payment_failed: { from: ['pending_payment'], to: 'held', by: ['system'] },
  expire: { from: ['pending_approval', 'held', 'pending_payment'], to: 'expired', by: ['system'] },
  cancel: { from: ['requested', 'pending_approval', 'held', 'pending_payment', 'confirmed'], to: 'cancelled', by: ['guest', 'host'] },
  check_in: { from: ['confirmed'], to: 'checked_in', by: ['guest', 'host'] },
  start_use: { from: ['checked_in'], to: 'in_use', by: ['guest', 'host', 'system'] },
  check_out: { from: ['checked_in', 'in_use'], to: 'completed', by: ['guest', 'host'] },
  no_show: { from: ['confirmed'], to: 'no_show', by: ['host'] },
} as const satisfies Record<string, { from: readonly WsStatus[]; to: WsStatus; by: readonly WsActor[] }>;
export type WsAction = keyof typeof WS_TRANSITIONS;

export function canTransition(action: WsAction, from: string, by: WsActor) {
  const t = WS_TRANSITIONS[action];
  return (t.from as readonly string[]).includes(from) && (t.by as readonly string[]).includes(by);
}

/** Statuses during which the chair is reserved. */
export const WS_ACTIVE: readonly WsStatus[] = ['pending_approval', 'held', 'pending_payment', 'confirmed', 'checked_in', 'in_use'];
/** Statuses in which the space is confirmed (the location can be shown to clients as confirmed). */
export const WS_CONFIRMED: readonly WsStatus[] = ['confirmed', 'checked_in', 'in_use', 'completed'];

/** D1c: approval requests hold the space for exactly 2 hours, never beyond the start. */
export const APPROVAL_HOLD_MIN = 120;
/** Time to complete payment once a space is held (instant mode or after approval), never beyond the start. */
export const PAYMENT_HOLD_MIN = 30;

// ── Terms ───────────────────────────────────────────────────────────────────
export const cancellationTerms = z.object({
  free_until_hours: z.number().int().min(0).max(720),
  fee_bp: z.number().int().min(0).max(10000),
}).strict();
export type CancellationTerms = z.infer<typeof cancellationTerms>;

export const lateTerms = z.object({
  grace_min: z.number().int().min(0).max(120),
  mode: z.enum(['per_15min', 'flat']),
  amount_minor: z.number().int().min(0).max(10_000_000),
}).strict();
export type LateTerms = z.infer<typeof lateTerms>;

// ── Listing inputs ──────────────────────────────────────────────────────────
export const PRICE_MODELS = ['fixed_hour', 'fixed_period', 'fixed_day'] as const;
/** D2: stored for later, rejected while disabled. */
export const DISABLED_PRICE_MODELS = ['percent', 'fixed_plus_percent'] as const;

const text = (n: number) => z.string().trim().max(n).nullable().optional();
const windowInput = z.object({ weekday: z.number().int().min(0).max(6), start_time: z.string().regex(/^\d{2}:\d{2}$/), end_time: z.string().regex(/^\d{2}:\d{2}$/) }).strict()
  .refine((w) => w.end_time > w.start_time, 'end_time must be after start_time');

export const listingInput = z.object({
  branch_id: z.string().uuid(),
  resource_id: z.string().uuid(),
  code: z.string().trim().min(1).max(20),
  title_ar: text(120), title_en: text(120),
  space_type: z.enum(['chair', 'station', 'room', 'other']).optional(),
  description_ar: text(2000), description_en: text(2000),
  photo_asset_ids: z.array(z.string().uuid()).max(10).optional(),
  specialties: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  min_duration_min: z.number().int().min(15).max(1440).optional(),
  max_duration_min: z.number().int().min(15).max(1440).optional(),
  setup_buffer_min: z.number().int().min(0).max(120).optional(),
  cleanup_buffer_min: z.number().int().min(0).max(120).optional(),
  price_model: z.enum([...PRICE_MODELS, ...DISABLED_PRICE_MODELS]).optional(),
  price_minor: z.number().int().min(0).max(100_000_000),
  period_min: z.number().int().min(30).max(1440).nullable().optional(),
  percent_bp: z.number().int().min(0).max(10000).nullable().optional(),
  percent_basis: z.enum(['service_net', 'service_gross']).nullable().optional(),
  included_resource_ids: z.array(z.string().uuid()).max(10).optional(),
  addons_discount_bp: z.number().int().min(0).max(10000).optional(),
  own_materials_policy_ar: text(1000), own_materials_policy_en: text(1000),
  cancellation_terms: cancellationTerms.optional(),
  late_terms: lateTerms.optional(),
  access_instructions_ar: text(2000), access_instructions_en: text(2000),
  usage_rules_ar: text(2000), usage_rules_en: text(2000),
  booking_mode: z.enum(['instant', 'approval']).optional(),
  windows: z.array(windowInput).max(42).optional(),
  addons: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('product'), product_variant_id: z.string().uuid(), max_quantity: z.number().int().min(1).max(50).optional() }).strict(),
    z.object({
      kind: z.literal('equipment'), resource_id: z.string().uuid(), name_ar: text(120), name_en: text(120),
      rental_price_minor: z.number().int().min(0).max(10_000_000), rental_unit: z.enum(['booking', 'hour']), max_quantity: z.literal(1).optional(),
    }).strict(),
  ])).max(30).optional(),
}).strict();
export type ListingInput = z.infer<typeof listingInput>;
export const listingUpdateInput = listingInput.partial().extend({ version: z.number().int().min(1) }).strict();
export const listingStatusInput = z.object({ status: z.enum(['published', 'paused', 'draft', 'archived']), version: z.number().int().min(1) }).strict();

export const staffLinksInput = z.object({ resource_id: z.string().uuid(), staff_ids: z.array(z.string().uuid()).max(20) }).strict();

// ── Guest inputs ────────────────────────────────────────────────────────────
export const searchInput = z.object({
  city: z.string().trim().max(80).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  duration_min: z.coerce.number().int().min(15).max(1440).default(120),
  space_type: z.enum(['chair', 'station', 'room', 'other']).optional(),
  specialty: z.string().trim().max(40).optional(),
  equipment: z.string().trim().max(80).optional(),
  max_price_minor: z.coerce.number().int().min(0).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  max_distance_km: z.coerce.number().min(0).max(500).optional(),
  sort: z.enum(['price', 'distance', 'rating', 'equipment_fit']).default('price'),
  /** Journey 2: start from one of her client appointments and look for compatible spaces. */
  booking_id: z.string().uuid().optional(),
});
export type SearchInput = z.infer<typeof searchInput>;

export const requestInput = z.object({
  listing_id: z.string().uuid(),
  start: z.string().datetime({ offset: true }),
  duration_min: z.number().int().min(15).max(1440),
  addons: z.array(z.object({ addon_id: z.string().uuid(), quantity: z.number().int().min(1).max(50) }).strict()).max(20).default([]),
  note: z.string().trim().max(500).optional(),
  /** Her own client appointments to place inside this space window (linked atomically). */
  link_booking_ids: z.array(z.string().uuid()).max(20).default([]),
  /** The terms version she reviewed; a changed listing must be reviewed again. */
  terms_version: z.number().int().min(1).optional(),
}).strict();
export type RequestInput = z.infer<typeof requestInput>;

export const reasonInput = z.object({ reason: z.string().trim().min(2).max(500) }).strict();
export const checkInInput = z.object({ code: z.string().regex(/^\d{6}$/).optional(), token: z.string().min(20).max(80).optional() }).strict()
  .refine((v) => !!v.code !== !!v.token, 'Provide the code or the QR token');
export const decisionInput = z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }).strict();
export const materialRequestInput = z.object({ addon_id: z.string().uuid(), quantity: z.number().int().min(1).max(50), note: z.string().trim().max(500).optional() }).strict();
export const reviewInput = z.object({ rating: z.number().int().min(1).max(5), body: z.string().trim().max(1000).optional() }).strict();
export const correctionInput = z.object({ amount_minor: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0), description: z.string().trim().min(2).max(300) }).strict();
export const linkBookingInput = z.object({ booking_id: z.string().uuid() }).strict();

// ── Pure pricing ────────────────────────────────────────────────────────────
export type PriceTerms = { price_model: string; price_minor: number; period_min: number | null };
export type TaxRule = { rate_bp: number; prices_include_tax: boolean };
export type QuoteAddon = { addon_id: string; kind: 'product' | 'equipment'; name: string; quantity: number; unit_price_minor: number; rental_unit: 'booking' | 'hour' | null };
export type QuoteLine = { kind: 'rent' | 'product' | 'equipment' | 'discount' | 'tax'; description: string; addon_id?: string; quantity: number; unit_price_minor: number; amount_minor: number; tax_included?: boolean };

/** Rent for a duration under a fixed price model (D2). */
export function rentFor(t: PriceTerms, durationMin: number) {
  if (!(t.price_model in { fixed_hour: 1, fixed_period: 1, fixed_day: 1 })) throw new Error('price_model_disabled');
  if (t.price_model === 'fixed_hour') return { units: durationMin / 60, amount: Math.round((t.price_minor * durationMin) / 60) };
  if (t.price_model === 'fixed_period') {
    const units = Math.ceil(durationMin / (t.period_min ?? 60));
    return { units, amount: units * t.price_minor };
  }
  const units = Math.max(1, Math.ceil(durationMin / 1440));
  return { units, amount: units * t.price_minor };
}

/** Tax on a base under the host's rule (same rule as bookings). */
export function taxOf(base: number, tax: TaxRule) {
  if (base <= 0 || !tax.rate_bp) return { tax: 0, total: Math.max(0, base) };
  if (tax.prices_include_tax) return { tax: Math.round((base * tax.rate_bp) / (10000 + tax.rate_bp)), total: base };
  const t = Math.round((base * tax.rate_bp) / 10000);
  return { tax: t, total: base + t };
}

/**
 * Full price before payment: base chair price, add-ons (products at store
 * price, equipment rental), the listing-wide add-on discount (D5b) and tax.
 */
export function quote(terms: PriceTerms & { addons_discount_bp: number }, durationMin: number, addons: QuoteAddon[], tax: TaxRule) {
  const rent = rentFor(terms, durationMin);
  const lines: QuoteLine[] = [{ kind: 'rent', description: 'rent', quantity: 1, unit_price_minor: rent.amount, amount_minor: rent.amount }];
  let addonsTotal = 0;
  for (const a of addons) {
    const unit = a.kind === 'equipment' && a.rental_unit === 'hour' ? Math.round((a.unit_price_minor * durationMin) / 60) : a.unit_price_minor;
    const amount = unit * a.quantity;
    addonsTotal += amount;
    lines.push({ kind: a.kind, description: a.name, addon_id: a.addon_id, quantity: a.quantity, unit_price_minor: unit, amount_minor: amount });
  }
  const discount = Math.round((addonsTotal * terms.addons_discount_bp) / 10000);
  if (discount > 0) lines.push({ kind: 'discount', description: 'addons_discount', quantity: 1, unit_price_minor: -discount, amount_minor: -discount });
  const base = rent.amount + addonsTotal - discount;
  const t = taxOf(base, tax);
  if (t.tax > 0) lines.push({ kind: 'tax', description: 'tax', quantity: 1, unit_price_minor: t.tax, amount_minor: t.tax, tax_included: tax.prices_include_tax });
  const baseOnly = taxOf(rent.amount, tax);
  return {
    lines, rent_minor: rent.amount, addons_minor: addonsTotal, discount_minor: discount, tax_minor: t.tax, total_minor: t.total,
    /** The chair alone (with tax) — shown next to the total so the expert sees both. */
    base_total_minor: baseOnly.total,
  };
}

/** D8: proposed late fee from the saved terms for a check-out `overMin` minutes after the end. */
export function lateFee(terms: LateTerms, overMin: number) {
  const late = overMin - terms.grace_min;
  if (late <= 0 || terms.amount_minor <= 0) return 0;
  return terms.mode === 'flat' ? terms.amount_minor : Math.ceil(late / 15) * terms.amount_minor;
}

/**
 * Refund on cancellation from the saved terms. The fee applies to the rent
 * only; add-ons are always refunded (nothing was handed over). A host
 * cancellation refunds everything.
 */
export function cancellationOutcome(o: { by: 'guest' | 'host' | 'system'; terms: CancellationTerms; paidMinor: number; rentGrossMinor: number; startsAt: Date; now: Date }) {
  if (o.paidMinor <= 0) return { refundMinor: 0, feeMinor: 0, basis: 'nothing_paid' as const };
  if (o.by !== 'guest') return { refundMinor: o.paidMinor, feeMinor: 0, basis: 'host_cancelled' as const };
  const hours = (o.startsAt.getTime() - o.now.getTime()) / 3_600_000;
  if (hours >= o.terms.free_until_hours) return { refundMinor: o.paidMinor, feeMinor: 0, basis: 'free_window' as const };
  const fee = Math.min(o.paidMinor, Math.round((o.rentGrossMinor * o.terms.fee_bp) / 10000));
  return { refundMinor: o.paidMinor - fee, feeMinor: fee, basis: 'late_cancellation' as const };
}

/** Great-circle distance in km (only when both coordinates are known). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}
