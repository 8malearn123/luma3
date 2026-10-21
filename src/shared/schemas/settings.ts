import { z } from 'zod';
import { isEmail, normalizePhone } from '../phone';

/** Tenant settings schemas (owner-managed; capability business.manage). */

export function isValidTimeZone(tz: string) {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) && tz !== 'UTC') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const zTimeZone = z.string().trim().max(64).refine(isValidTimeZone, 'Enter a valid IANA timezone, e.g. Asia/Riyadh');
const zPhone = z.string().trim().max(30).refine((v) => normalizePhone(v) !== null, 'Enter a valid phone number');
const zEmail = z.string().trim().max(254).refine(isEmail, 'Enter a valid email address');

/** Social profiles are stored as handles only (no URLs, no scripts); links are built at render time. */
export const SOCIAL_NETWORKS = ['instagram', 'tiktok', 'snapchat', 'x', 'youtube', 'facebook'] as const;
export const zHandle = z.string().trim().transform((v) => v.replace(/^@/, '')).pipe(z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, 'Enter the handle only, without a link'));
export const zSocial = z.object(Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, zHandle.nullable().optional()])) as Record<(typeof SOCIAL_NETWORKS)[number], z.ZodOptional<z.ZodNullable<typeof zHandle>>>).strict();

const v = { version: z.number().int().min(1) };

export const profileInput = z.object({
  ...v,
  name: z.string().trim().min(1).max(120),
  city: z.string().trim().max(80).nullable().optional(),
  default_locale: z.enum(['ar', 'en']),
  timezone: zTimeZone,
  contact_phone: zPhone.nullable().optional(),
  contact_email: zEmail.nullable().optional(),
  contact_whatsapp: zPhone.nullable().optional(),
  social_links: zSocial.optional(),
}).strict();

export const ANY_STAFF_RULES = ['earliest_then_least_booked', 'earliest_then_staff_order'] as const;
export const bookingPolicyInput = z.object({
  ...v,
  slot_increment_min: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
  min_notice_min: z.number().int().min(0).max(10080),
  max_advance_days: z.number().int().min(1).max(365),
  hold_ttl_sec: z.number().int().min(60).max(3600),
  no_show_grace_min: z.number().int().min(0).max(240),
  max_gap_between_items_min: z.number().int().min(0).max(240),
  any_staff_rule: z.enum(ANY_STAFF_RULES),
  free_cancellation_hours: z.number().int().min(0).max(720),
  late_cancellation_fee_bp: z.number().int().min(0).max(10000),
  deposit_mode: z.enum(['none', 'percent', 'fixed']),
  deposit_percent_bp: z.number().int().min(0).max(10000),
  deposit_fixed_minor: z.number().int().min(0).max(100_000_000),
  allow_full_prepay: z.boolean(),
  allow_pay_on_site: z.boolean(),
  booking_requires_account: z.boolean(),
  booking_policy_text_ar: z.string().trim().max(5000).nullable().optional(),
  booking_policy_text_en: z.string().trim().max(5000).nullable().optional(),
}).strict().superRefine((p, ctx) => {
  if (p.deposit_mode === 'percent' && p.deposit_percent_bp <= 0) ctx.addIssue({ code: 'custom', path: ['deposit_percent_bp'], message: 'Set a deposit percentage above 0' });
  if (p.deposit_mode === 'fixed' && p.deposit_fixed_minor <= 0) ctx.addIssue({ code: 'custom', path: ['deposit_fixed_minor'], message: 'Set a deposit amount above 0' });
  if (!p.allow_full_prepay && !p.allow_pay_on_site && p.deposit_mode === 'none') ctx.addIssue({ code: 'custom', path: ['allow_pay_on_site'], message: 'Allow at least one way to pay' });
});

export const policyConfirmInput = z.object({ ...v, confirmed: z.literal(true) }).strict();

export const legalTaxInput = z.object({
  ...v,
  legal_name: z.string().trim().max(200).nullable().optional(),
  tax_number: z.string().trim().regex(/^[0-9A-Za-z-]{5,30}$/, 'Digits and letters only').nullable().optional(),
  legal_address: z.string().trim().max(400).nullable().optional(),
  tax_rate_bp: z.number().int().min(0).max(10000),
  prices_include_tax: z.boolean(),
  tax_label: z.string().trim().max(40).nullable().optional(),
}).strict();

export const NOTIFY_CHANNELS = ['in_app', 'email', 'sms', 'whatsapp'] as const;
export const notificationsInput = z.object({
  ...v,
  notify_channels: z.array(z.enum(NOTIFY_CHANNELS)).max(4),
}).strict();

export const displayInput = z.object({ ...v, time_format: z.enum(['12h', '24h']) }).strict();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const hoursInput = z.array(z.object({ weekday: z.number().int().min(0).max(6), opens: hhmm, closes: hhmm }).strict()).max(42);

export const branchInput = z.object({
  name: z.string().trim().min(1).max(120),
  city: z.string().trim().max(80).nullable().optional(),
  address: z.string().trim().max(400).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  timezone: zTimeZone.default('Asia/Riyadh'),
  phone: zPhone.nullable().optional(),
  hours: hoursInput.optional(),
}).strict();

export const branchPatch = branchInput.partial().extend({
  version: z.number().int().min(1),
  is_primary: z.literal(true).optional(),
  status: z.enum(['active', 'archived']).optional(),
}).strict();

export const tenantAuditQuery = z.object({
  action: z.string().trim().regex(/^[a-z0-9_.]{1,80}$/).optional(),
  actor_user_id: z.string().uuid().optional(),
  actor_kind: z.enum(['user', 'platform', 'support', 'system', 'customer', 'anonymous']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  support_only: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(400).optional(),
});

export const planChangeInput = z.object({
  plan_code: z.string().regex(/^[a-z0-9_]{2,32}$/),
  /** Required (true) when the downgrade leaves the business above the new plan's limits. */
  confirm_overage: z.boolean().optional(),
}).strict();
export const planPreviewQuery = z.object({ plan_code: z.string().regex(/^[a-z0-9_]{2,32}$/) });
export const cancelInput = z.object({ action: z.enum(['cancel_at_period_end', 'keep']) }).strict();

/** Explains ranges overlapping in a day (multiple ranges per day are allowed). */
export function overlappingRanges(hours: Array<{ weekday: number; opens: string; closes: string }>) {
  const byDay = new Map<number, Array<{ opens: string; closes: string }>>();
  for (const h of hours) byDay.set(h.weekday, [...(byDay.get(h.weekday) ?? []), h]);
  for (const list of byDay.values()) {
    const s = [...list].sort((a, b) => a.opens.localeCompare(b.opens));
    for (let i = 1; i < s.length; i++) if (s[i]!.opens < s[i - 1]!.closes) return true;
  }
  return false;
}
