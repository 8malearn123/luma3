import { z } from 'zod';

const num = (min: number, max: number) => z.coerce.number().min(min).max(max).optional();

export const marketSearchQuery = z.object({
  q: z.string().trim().max(80).optional(),
  door: z.enum(['salons', 'experts']).optional(),
  type: z.enum(['salon', 'beauty_center', 'spa', 'expert']).optional(),
  specialty: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  min_rating: num(0, 5),
  price_min: z.coerce.number().int().min(0).max(100_000_000).optional(),
  price_max: z.coerce.number().int().min(0).max(100_000_000).optional(),
  sort: z.enum(['best', 'nearest', 'top_rated', 'most_booked', 'price_asc', 'price_desc']).default('best'),
  lat: num(-90, 90),
  lng: num(-180, 180),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(24),
}).strip();

export const favoriteInput = z.object({ slug: z.string().trim().regex(/^[a-z0-9-]{3,48}$/) }).strict();
export const exploreQuery = z.object({ city: z.string().trim().max(80).optional() }).strip();

export const listingPatchInput = z.object({
  hidden: z.boolean().optional(),
  tagline_ar: z.string().trim().max(160).nullable().optional(),
  tagline_en: z.string().trim().max(160).nullable().optional(),
  cover_asset_id: z.string().uuid().nullable().optional(),
}).strict();

const reason = z.string().trim().max(500).optional().nullable();
export const reviewDecisionInput = z.object({ decision: z.enum(['approve', 'reject']), reason }).strict()
  .refine((v) => v.decision === 'approve' || (v.reason && v.reason.length >= 3), { message: 'A reason is required to reject', path: ['reason'] });

export const queueQuery = z.object({ status: z.enum(['draft', 'pending', 'approved', 'rejected', 'verified']).optional() }).strip();

export const commissionInput = z.object({ commission_bp: z.number().int().min(0).max(10000).nullable() }).strict();
export const marketSettingsInput = z.object({
  require_verification: z.boolean().optional(),
  default_commission_bp: z.number().int().min(0).max(10000).optional(),
}).strict();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const feePeriodQuery = z.object({ from: day, to: day }).strip();
