import { z } from 'zod';

const name = z.string().trim().max(160);
const desc = z.string().trim().max(4000);
const money = z.number().int().min(0).max(100_000_000); // minor units (halalas)

export const categoryInput = z.object({
  kind: z.enum(['service', 'product']),
  name_ar: name.optional().nullable(),
  name_en: name.optional().nullable(),
  slug: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
  is_visible: z.boolean().optional(),
}).refine((v) => !!(v.name_ar || v.name_en), { message: 'A name is required', path: ['name_ar'] });

export const categoryPatch = z.object({
  name_ar: name.optional().nullable(), name_en: name.optional().nullable(), is_visible: z.boolean().optional(), archived: z.boolean().optional(),
});

export const serviceInput = z.object({
  name_ar: name.optional().nullable(),
  name_en: name.optional().nullable(),
  description_ar: desc.optional().nullable(),
  description_en: desc.optional().nullable(),
  category_id: z.string().uuid().nullable().optional(),
  branch_id: z.string().uuid().nullable().optional(),
  price_minor: money,
  price_display: z.enum(['fixed', 'starting_from']).default('fixed'),
  duration_min: z.number().int().min(5).max(720),
  buffer_before_min: z.number().int().min(0).max(240).default(0),
  buffer_after_min: z.number().int().min(0).max(240).default(0),
  image_asset_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().default(true),
  is_visible: z.boolean().default(true),
  bookable_internally_when_hidden: z.boolean().default(true),
  booking_mode: z.enum(['individual', 'group']).default('individual'),
  min_notice_min: z.number().int().min(0).max(10080).nullable().optional(),
  max_advance_days: z.number().int().min(1).max(365).nullable().optional(),
  requires_manual_approval: z.boolean().default(false),
  cost_minor: money.nullable().optional(),
  staff: z.array(z.object({
    staff_id: z.string().uuid(),
    price_override_minor: money.nullable().optional(),
    duration_override_min: z.number().int().min(5).max(720).nullable().optional(),
  })).max(100).optional(),
  resource_requirements: z.array(z.object({ resource_type_id: z.string().uuid(), quantity: z.number().int().min(1).max(5).default(1) })).max(5).optional(),
}).refine((v) => !!(v.name_ar || v.name_en), { message: 'A name is required', path: ['name_ar'] });
export type ServiceInput = z.infer<typeof serviceInput>;

export const servicePatch = z.object({
  version: z.number().int().min(1),
  name_ar: name.optional().nullable(),
  name_en: name.optional().nullable(),
  description_ar: desc.optional().nullable(),
  description_en: desc.optional().nullable(),
  category_id: z.string().uuid().nullable().optional(),
  branch_id: z.string().uuid().nullable().optional(),
  // Price changes go through proposals; direct price edits are allowed only before the service has bookings.
  price_minor: money.optional(),
  price_display: z.enum(['fixed', 'starting_from']).optional(),
  duration_min: z.number().int().min(5).max(720).optional(),
  buffer_before_min: z.number().int().min(0).max(240).optional(),
  buffer_after_min: z.number().int().min(0).max(240).optional(),
  image_asset_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
  is_visible: z.boolean().optional(),
  bookable_internally_when_hidden: z.boolean().optional(),
  min_notice_min: z.number().int().min(0).max(10080).nullable().optional(),
  max_advance_days: z.number().int().min(1).max(365).nullable().optional(),
  requires_manual_approval: z.boolean().optional(),
  cost_minor: money.nullable().optional(),
  sort: z.number().int().min(0).max(10000).optional(),
  staff: serviceInput.shape.staff,
  resource_requirements: serviceInput.shape.resource_requirements,
});

const variantFields = z.object({
  name_ar: name.optional().nullable(), name_en: name.optional().nullable(), price_minor: money, duration_min: z.number().int().min(5).max(720),
  is_active: z.boolean(),
});
export const variantInput = variantFields.extend({ is_active: z.boolean().default(true) })
  .refine((v) => !!(v.name_ar || v.name_en), { message: 'A name is required', path: ['name_ar'] });
/** PATCH: only the fields sent are changed (no defaults, so omitted fields are never reset). */
export const variantPatch = variantFields.partial();

const addonFields = z.object({
  name_ar: name.optional().nullable(), name_en: name.optional().nullable(), price_minor: money, duration_min: z.number().int().min(0).max(240),
  is_active: z.boolean(),
});
export const addonInput = addonFields.extend({ duration_min: addonFields.shape.duration_min.default(0), is_active: z.boolean().default(true) })
  .refine((v) => !!(v.name_ar || v.name_en), { message: 'A name is required', path: ['name_ar'] });
/** PATCH: only the fields sent are changed. */
export const addonPatch = addonFields.partial();

export const packageInput = z.object({
  name_ar: name.optional().nullable(), name_en: name.optional().nullable(), description_ar: desc.optional().nullable(), description_en: desc.optional().nullable(),
  price_minor: money, service_ids: z.array(z.string().uuid()).min(2).max(10), is_active: z.boolean().default(true), is_visible: z.boolean().default(true),
}).refine((v) => !!(v.name_ar || v.name_en), { message: 'A name is required', path: ['name_ar'] });

export const priceProposalInput = z.object({ proposed_price_minor: money, reason: z.string().trim().max(500).optional() });

export const reorderInput = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });
