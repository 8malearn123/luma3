import { z } from 'zod';
import { zBrand } from './theme';

/** Request schemas for the builder API (shared by routes and the editor). */

const version = z.number().int().min(0);

/** Blocks are validated by the registry (validateBlocks) in the service, not here. */
export const savePageBlocksInput = z.object({ version, blocks: z.array(z.unknown()).max(200) }).strict();
export const saveLayoutInput = z.object({ version, layout: z.unknown() }).strict();
export const saveBrandInput = z.object({ version, brand: zBrand }).strict();

export const pageSlug = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, 'Use lowercase letters, digits and dashes');
const title = z.string().trim().max(120);

export const createPageInput = z.object({
  title_ar: title.nullable().optional(),
  title_en: title.nullable().optional(),
  slug: pageSlug,
  show_in_nav: z.boolean().default(false),
  show_in_footer: z.boolean().default(true),
}).strict().refine((v) => !!(v.title_ar || v.title_en), { message: 'A title is required', path: ['title_ar'] });

export const updatePageInput = z.object({
  title_ar: title.nullable().optional(),
  title_en: title.nullable().optional(),
  slug: pageSlug.optional(),
  show_in_nav: z.boolean().optional(),
  show_in_footer: z.boolean().optional(),
  sort: z.number().int().min(0).max(1000).optional(),
  restore: z.boolean().optional(),
}).strict();

export const publishInput = z.object({ note: z.string().trim().max(200).optional() }).strict();
export const previewTokenInput = z.object({ ttl_hours: z.number().int().min(1).max(168).default(24) }).strict();
export const applyTemplateInput = z.object({ pages: z.array(z.string().max(30)).max(12).optional() }).strict();
export const proposalInput = z.object({ request_text: z.string().trim().min(3).max(1000), page_id: z.string().uuid().optional() }).strict();
