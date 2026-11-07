import { z } from 'zod';

const caption = z.string().trim().max(160).optional().nullable();

export const portfolioItemInput = z.object({
  before_asset_id: z.string().uuid().nullable().default(null),
  after_asset_id: z.string().uuid(),
  caption_ar: caption,
  caption_en: caption,
  category: z.string().trim().max(40).optional().nullable(),
  service_id: z.string().uuid().nullable().optional(),
  is_visible: z.boolean().default(true),
  sort: z.number().int().min(0).max(10000).optional(),
}).strict().refine((v) => v.before_asset_id !== v.after_asset_id, { path: ['before_asset_id'], message: 'Before and after must be different images' });
export type PortfolioItemInput = z.infer<typeof portfolioItemInput>;

export const portfolioItemPatch = z.object({
  before_asset_id: z.string().uuid().nullable().optional(),
  after_asset_id: z.string().uuid().optional(),
  caption_ar: caption,
  caption_en: caption,
  category: z.string().trim().max(40).optional().nullable(),
  service_id: z.string().uuid().nullable().optional(),
  is_visible: z.boolean().optional(),
  sort: z.number().int().min(0).max(10000).optional(),
}).strict();
