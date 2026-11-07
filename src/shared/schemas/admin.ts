import { z } from 'zod';

/** Zod schemas for the phase-2 LUMA administration endpoints (docs/PLATFORM_ADMIN.md). */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const slug = z.string().trim().regex(/^[a-z0-9-]{3,48}$/);
const format = z.enum(['json', 'csv']).default('json');
const reason = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(300);

export const periodQuery = z.object({ from: isoDate.optional(), to: isoDate.optional(), format });

export const BOOKING_STATUSES = ['draft', 'held', 'pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'in_service', 'completed', 'expired', 'cancelled', 'no_show'] as const;
export const BOOKING_SOURCES = ['storefront', 'dashboard', 'walk_in', 'waitlist', 'reschedule', 'marketplace'] as const;
export const PAYMENT_STATUSES = ['pending', 'requires_action', 'authorized', 'captured', 'failed', 'cancelled', 'expired'] as const;
export const PAYMENT_PURPOSES = ['booking', 'order', 'gift_card', 'membership'] as const;

export const activityBookingsQuery = z.object({
  tenant: slug.optional(), status: z.enum(BOOKING_STATUSES).optional(), source: z.string().regex(/^[a-z_]{2,32}$/).optional(),
  from: isoDate.optional(), to: isoDate.optional(), format,
  page: z.coerce.number().int().min(1).max(10_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const activityPaymentsQuery = z.object({
  tenant: slug.optional(), status: z.enum(PAYMENT_STATUSES).optional(), source: z.enum(PAYMENT_PURPOSES).optional(),
  method: z.string().regex(/^[a-z_]{2,32}$/).optional(),
  from: isoDate.optional(), to: isoDate.optional(), format,
  page: z.coerce.number().int().min(1).max(10_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const REPORT_KINDS = ['monthly_revenue', 'vat_summary', 'provider_performance', 'bookings'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const promotionCreateInput = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{3,32}$/).nullable().optional(),
  name_ar: z.string().trim().min(1).max(120),
  name_en: z.string().trim().min(1).max(120),
  discount_bp: z.number().int().min(1).max(10_000),
  plan_codes: z.array(z.string().regex(/^[a-z0-9_]{2,32}$/)).max(10).optional(),
  billing_cycles: z.array(z.enum(['monthly', 'yearly'])).max(2).optional(),
  starts_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
  duration_cycles: z.number().int().min(1).max(120).nullable().optional(),
  max_redemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
}).strict().refine((v) => new Date(v.ends_at) > new Date(v.starts_at), { message: 'ends_at must be after starts_at', path: ['ends_at'] });

export const promotionUpdateInput = z.object({
  version: z.number().int().min(1),
  name_ar: z.string().trim().min(1).max(120).optional(),
  name_en: z.string().trim().min(1).max(120).optional(),
  discount_bp: z.number().int().min(1).max(10_000).optional(),
  starts_at: z.iso.datetime({ offset: true }).optional(),
  ends_at: z.iso.datetime({ offset: true }).optional(),
  max_redemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict();

export const approvalListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(400).optional(),
});
export const approvalDecisionInput = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(3).max(500).optional() }).strict();

// ── Referrals ───────────────────────────────────────────────────────────────
export const REFERRAL_CODE_RE = /^[A-Za-z0-9_-]{4,32}$/;
export const zIban = z.string().trim().transform((s) => s.replace(/\s+/g, '').toUpperCase()).pipe(z.string().regex(/^SA[0-9]{22}$/, 'Enter a Saudi IBAN (SA + 22 digits)'));

export const marketerCreateInput = z.object({
  display_name: z.string().trim().min(1).max(120),
  code: z.string().trim().regex(REFERRAL_CODE_RE).optional(),
  contact_email: z.email().max(200).optional(),
  contact_phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/).optional(),
  rate_bp: z.number().int().min(0).max(10_000).nullable().optional(),
  iban: zIban.optional(),
}).strict();
export const referrerUpdateInput = z.object({
  version: z.number().int().min(1),
  display_name: z.string().trim().min(1).max(120).optional(),
  rate_bp: z.number().int().min(0).max(10_000).nullable().optional(),
  iban: zIban.nullable().optional(),
  status: z.enum(['active', 'suspended']).optional(),
}).strict();
export const withdrawalRequestInput = z.object({
  amount_minor: z.number().int().min(1).max(100_000_000),
  iban: zIban,
  account_name: z.string().trim().min(2).max(120),
}).strict();
export const withdrawalDecisionInput = z.object({
  action: z.enum(['approve', 'reject', 'mark_paid']),
  reason: reason.optional(),
  reference: z.string().trim().min(2).max(120).optional(),
}).strict();
export const withdrawalListQuery = z.object({
  status: z.enum(['requested', 'approved', 'rejected', 'paid']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const referralAdjustInput = z.object({ amount_minor: z.number().int().min(-100_000_000).max(100_000_000).refine((n) => n !== 0), note: reason }).strict();

// ── Settlements ─────────────────────────────────────────────────────────────
export const settlementGenerateInput = z.object({ from: isoDate, to: isoDate, tenant: slug.optional() }).strict();
export const settlementListQuery = z.object({
  tenant: slug.optional(), status: z.enum(['simulated', 'settled']).optional(), from: isoDate.optional(), to: isoDate.optional(), format,
  page: z.coerce.number().int().min(1).max(10_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const settlementSettleInput = z.object({ reference: z.string().trim().min(2).max(120) }).strict();

export const feedQuery = z.object({ since: z.iso.datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(40) });
