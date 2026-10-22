import { z } from 'zod';
import { hex, zFontKey } from './builder/theme';

/** The seven onboarding steps. Every field except the business name is optional. */
export const BUSINESS_TYPES = ['salon', 'expert', 'beauty_center', 'spa'] as const;
export const CHARACTER_TRAITS = ['elegant', 'modern', 'warm', 'minimal', 'luxurious', 'playful', 'natural', 'bold'] as const;
export const SPECIALTIES = ['hair', 'nails', 'makeup', 'skin', 'lashes_brows', 'bridal', 'spa', 'henna', 'hair_removal'] as const;
export const AUDIENCES = ['women', 'brides', 'teens', 'professionals', 'mothers', 'tourists'] as const;
export const PRIORITIES = ['booking', 'portfolio', 'products', 'offers', 'reviews', 'team'] as const;

export const zSlug = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, 'Use 3-48 lowercase letters, digits or hyphens');

export const step1 = z.object({
  name: z.string().trim().min(1).max(120),
  business_type: z.enum(BUSINESS_TYPES),
  city: z.string().trim().max(80).optional(),
  branch_name: z.string().trim().max(120).optional(),
  slug: zSlug.optional(),
}).strict();

export const step2 = z.object({
  has_existing_identity: z.boolean().optional(),
  logo_asset_id: z.string().uuid().nullable().optional(),
  wordmark_text: z.string().trim().max(60).optional(),
}).strict();

export const step3 = z.object({
  traits: z.array(z.enum(CHARACTER_TRAITS)).max(3).optional(),
  reference_style: z.enum(['soft_minimal', 'classic_luxury', 'modern_bold', 'natural_warm']).optional(),
  description: z.string().trim().max(600).optional(),
}).strict();

export const step4 = z.object({
  existing_colors: z.array(hex).max(4).optional(),
  excluded_colors: z.array(hex).max(6).optional(),
  accepted_palette: z.record(z.string(), hex).optional(),
  fonts: z.object({ heading: zFontKey, body: zFontKey }).optional(),
}).strict();

const zServiceSeed = z.object({
  name: z.string().trim().min(1).max(120),
  price_sar: z.number().min(0).max(100000).optional(),
  duration_min: z.number().int().min(5).max(720).optional(),
}).strict();

export const step5 = z.object({
  specialties: z.array(z.enum(SPECIALTIES)).max(9).optional(),
  audience: z.array(z.enum(AUDIENCES)).max(6).optional(),
  // Only services the owner actually enters are created. Nothing is invented.
  services: z.array(zServiceSeed).max(30).optional(),
}).strict();

export const step6 = z.object({ priorities: z.array(z.enum(PRIORITIES)).max(6).optional() }).strict();

const zHour = z.object({ weekday: z.number().int().min(0).max(6), opens: z.string().regex(/^\d{2}:\d{2}$/), closes: z.string().regex(/^\d{2}:\d{2}$/) }).strict();

export const step7 = z.object({
  cover_asset_id: z.string().uuid().nullable().optional(),
  intro: z.string().trim().max(1500).optional(),
  tagline: z.string().trim().max(140).optional(),
  phone: z.string().trim().max(30).optional(),
  whatsapp: z.string().trim().max(30).optional(),
  email: z.string().trim().email().max(254).optional().or(z.literal('')),
  address: z.string().trim().max(300).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  hours: z.array(zHour).max(21).optional(),
  social: z.object({
    instagram: z.string().trim().max(80).optional(), tiktok: z.string().trim().max(80).optional(),
    snapchat: z.string().trim().max(80).optional(), x: z.string().trim().max(80).optional(),
  }).strict().optional(),
}).strict();

export const STEP_SCHEMAS = { 1: step1, 2: step2, 3: step3, 4: step4, 5: step5, 6: step6, 7: step7 } as const;
export type StepNumber = keyof typeof STEP_SCHEMAS;

export type OnboardingAnswers = {
  1?: z.infer<typeof step1>; 2?: z.infer<typeof step2>; 3?: z.infer<typeof step3>; 4?: z.infer<typeof step4>;
  5?: z.infer<typeof step5>; 6?: z.infer<typeof step6>; 7?: z.infer<typeof step7>;
};

export const createBusinessSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: zSlug,
  business_type: z.enum(BUSINESS_TYPES),
  city: z.string().trim().max(80).optional(),
  branch_name: z.string().trim().max(120).optional(),
  plan_code: z.string().regex(/^[a-z0-9_]{2,32}$/).optional(),
  /** Expert businesses: the owner is also the bookable provider. */
  owner_is_provider: z.boolean().optional(),
}).strict();

/** Suggests a latin slug from a (possibly Arabic) business name. */
export function suggestSlug(name: string): string {
  const map: Record<string, string> = {
    ا: 'a', أ: 'a', إ: 'e', آ: 'a', ب: 'b', ت: 't', ث: 'th', ج: 'j', ح: 'h', خ: 'kh', د: 'd', ذ: 'th', ر: 'r', ز: 'z', س: 's', ش: 'sh',
    ص: 's', ض: 'd', ط: 't', ظ: 'z', ع: 'a', غ: 'gh', ف: 'f', ق: 'q', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h', و: 'w', ي: 'y', ى: 'a', ة: 'a', ء: '', ئ: 'e', ؤ: 'o',
  };
  const s = name.trim().toLowerCase().split('').map((ch) => map[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s.length >= 3 ? s : `${s || 'salon'}-${Math.floor(Math.random() * 9000 + 1000)}`;
}
