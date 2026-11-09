import { z } from 'zod';

/**
 * LUMA platform settings (table `platform_settings`, key → jsonb). The defaults
 * below are authoritative when a row is missing, and mirror the rows seeded by
 * migration 0630. Other domains read them with getPlatformSettings():
 *
 * Whether the marketplace requires verification lives in `marketplace_settings`
 * (managed on /platform/marketplace), not here.
 * - `maintenance_mode` locks business dashboards only; storefronts and
 *   customer booking keep working.
 */
export const PLATFORM_SETTINGS_SCHEMA = z.object({
  platform_name: z.string().trim().min(1).max(60),
  maintenance_mode: z.boolean(),
  maintenance_message_ar: z.string().trim().max(400),
  maintenance_message_en: z.string().trim().max(400),
  allow_signups: z.boolean(),
  require_business_approval: z.boolean(),
  founding_enabled: z.boolean(),
  founding_seats_total: z.number().int().min(0).max(100_000),
  founding_discount_bp: z.number().int().min(0).max(10_000),
  referral_default_rate_bp: z.number().int().min(0).max(10_000),
  referral_min_withdrawal_minor: z.number().int().min(0).max(100_000_000),
});

export type PlatformSettings = z.infer<typeof PLATFORM_SETTINGS_SCHEMA>;
export type PlatformSettingKey = keyof PlatformSettings;

export const PLATFORM_SETTING_DEFAULTS: PlatformSettings = {
  platform_name: 'LUMA',
  maintenance_mode: false,
  maintenance_message_ar: 'نعمل على تحسينات في لوحة التحكم. متجركِ والحجوزات تعمل كالمعتاد.',
  maintenance_message_en: 'We are improving the dashboard. Your storefront and bookings keep working.',
  allow_signups: true,
  require_business_approval: false,
  founding_enabled: true,
  founding_seats_total: 100,
  founding_discount_bp: 3000,
  referral_default_rate_bp: 1000,
  referral_min_withdrawal_minor: 10000,
};

/** PUT /api/v1/platform/settings: any subset of keys. */
export const platformSettingsUpdateInput = PLATFORM_SETTINGS_SCHEMA.partial().strict();

/** Applies basis-point discounts in sequence (founding first, then a promotion); rounds to the halala. */
export function applyDiscounts(listMinor: number, discountsBp: number[]) {
  let amount = listMinor;
  for (const bp of discountsBp) if (bp > 0) amount = Math.round((amount * (10_000 - bp)) / 10_000);
  return amount;
}

/** Yearly list price derived from a monthly price: two months free. */
export const yearlyFromMonthly = (monthlyMinor: number) => monthlyMinor * 10;

/** VAT portion of a VAT-inclusive amount (Saudi VAT 15%). */
export const VAT_RATE_BP = 1500;
export function vatOfInclusive(grossMinor: number, rateBp = VAT_RATE_BP) {
  return Math.round((grossMinor * rateBp) / (10_000 + rateBp));
}
