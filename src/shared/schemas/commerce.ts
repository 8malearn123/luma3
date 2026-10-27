import { z } from 'zod';
import { UNITS } from '../units';

const name = z.string().trim().max(160);
const desc = z.string().trim().max(4000);
const money = z.number().int().min(0).max(100_000_000); // minor units (halalas)
const qty3 = z.number().finite().refine((n) => Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6, { message: 'At most 3 decimal places' });
const code = z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only');

export const ORDER_STATUSES = ['draft', 'pending_payment', 'paid', 'preparing', 'ready', 'collected', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const FULFILLMENT_STEPS = ['preparing', 'ready', 'collected'] as const;
export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export const INVENTORY_KINDS = ['retail', 'material', 'both'] as const;

// ── Products ────────────────────────────────────────────────────────────────
export const variantInput = z.object({
  id: z.string().uuid().optional(),
  name_ar: name.nullable().optional(),
  name_en: name.nullable().optional(),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  barcode: z.string().trim().min(1).max(64).nullable().optional(),
  price_minor: money,
  cost_minor: money.nullable().optional(),
  is_active: z.boolean().optional(),
  /** Only on creation: opening stock recorded as a 'receipt' movement. */
  initial_stock: z.number().int().min(0).max(1_000_000).optional(),
  low_stock_threshold: z.number().min(0).max(1_000_000).nullable().optional(),
});

const productBase = {
  name_ar: name.nullable().optional(),
  name_en: name.nullable().optional(),
  description_ar: desc.nullable().optional(),
  description_en: desc.nullable().optional(),
  category_id: z.string().uuid().nullable().optional(),
  status: z.enum(['draft', 'active']).optional(),
  is_visible: z.boolean().optional(),
  hide_when_out_of_stock: z.boolean().optional(),
  max_per_order: z.number().int().min(1).max(999).optional(),
  returnable: z.boolean().optional(),
  image_asset_ids: z.array(z.string().uuid()).max(10).optional(),
};

export const productInput = z.object({
  ...productBase,
  /** First variant is the default variant. */
  variants: z.array(variantInput).min(1).max(50),
}).strict().refine((v) => !!(v.name_ar || v.name_en), { message: 'A name is required', path: ['name_ar'] });
export type ProductInput = z.infer<typeof productInput>;

export const productPatch = z.object({
  version: z.number().int().min(1),
  ...productBase,
  /** Upsert: variants with id are updated, without id created; omitted ones are deactivated (never deleted). */
  variants: z.array(variantInput).min(1).max(50).optional(),
}).strict();
export type ProductPatch = z.infer<typeof productPatch>;

export const productListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'active', 'archived', 'all']).optional(),
  category_id: z.string().uuid().optional(),
  stock: z.enum(['in', 'low', 'out']).optional(),
  sort: z.enum(['name', 'price', 'stock', 'created']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const archiveInput = z.object({ archived: z.boolean() }).strict();

// ── Inventory ───────────────────────────────────────────────────────────────
/**
 * Creates a service-consumption material. Retail items are created with their
 * product variant; a retail item becomes "both" (sold and consumed) via PATCH.
 */
export const inventoryItemInput = z.object({
  name: z.string().trim().min(1).max(160),
  unit: z.enum(UNITS),
  branch_id: z.string().uuid().optional(),
  low_stock_threshold: z.number().min(0).max(1_000_000).nullable().optional(),
  cost_per_unit_minor: money.nullable().optional(),
  initial_quantity: qty3.pipe(z.number().min(0).max(10_000_000)).optional(),
}).strict();

export const inventoryItemPatch = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  kind: z.enum(['retail', 'both']).optional(),
  low_stock_threshold: z.number().min(0).max(1_000_000).nullable().optional(),
  cost_per_unit_minor: money.nullable().optional(),
  is_active: z.boolean().optional(),
}).strict();

export const inventoryListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(['retail', 'material', 'both', 'all']).optional(),
  low: z.enum(['0', '1']).optional(),
  /** Items holding stock that nothing has drawn from recently (see commerce/idle.ts). */
  idle: z.enum(['0', '1']).optional(),
  include_inactive: z.enum(['0', '1']).optional(),
  sort: z.enum(['name', 'available', 'on_hand', 'updated']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const movementInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('receipt'),
    quantity: qty3.pipe(z.number().positive().max(10_000_000)),
    unit: z.enum(UNITS).optional(),
    reason: z.string().trim().max(500).optional(),
  }).strict(),
  z.object({
    kind: z.literal('adjustment'),
    /** Signed: negative removes stock (damage, count correction, extra usage). */
    quantity: qty3.pipe(z.number().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, 'Must not be zero')),
    unit: z.enum(UNITS).optional(),
    reason: z.string().trim().min(3).max(500),
    /** Links a correction to a service visit whose actual usage differed from the recipe. */
    booking_item_id: z.string().uuid().optional(),
  }).strict(),
]);
export type MovementInput = z.infer<typeof movementInput>;

export const recipeInput = z.object({
  lines: z.array(z.object({
    inventory_item_id: z.string().uuid(),
    quantity: qty3.pipe(z.number().positive().max(1_000_000)),
    unit: z.enum(UNITS),
  }).strict()).max(30),
}).strict();

export const consumeInput = z.object({ booking_item_id: z.string().uuid() }).strict();

// ── Physical stock counts ────────────────────────────────────────────────────
export const stockCountInput = z.object({
  branch_id: z.string().uuid().optional(),
  kind: z.enum(['retail', 'material', 'all']).default('all'),
  note: z.string().trim().max(500).optional(),
  /** Differences above this % of the system quantity are flagged; 0 flags any difference. */
  tolerance_pct: z.number().min(0).max(100).default(0),
}).strict();

export const stockCountLinesInput = z.object({
  version: z.number().int().positive(),
  note: z.string().trim().max(500).nullable().optional(),
  lines: z.array(z.object({
    inventory_item_id: z.string().uuid(),
    /** null clears a line that was entered by mistake. */
    counted_quantity: qty3.pipe(z.number().min(0).max(10_000_000)).nullable(),
  }).strict()).max(500),
}).strict();

export const stockCountApplyInput = z.object({ version: z.number().int().positive() }).strict();

// ── Coupons ─────────────────────────────────────────────────────────────────
export const couponInput = z.object({
  code,
  kind: z.enum(['percent', 'fixed']),
  /** percent: basis points (1500 = 15%); fixed: minor units. */
  value: z.number().int().min(1).max(100_000_000),
  applies_to: z.enum(['all', 'services', 'products']).default('all'),
  min_subtotal_minor: money.default(0),
  max_redemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  per_customer_limit: z.number().int().min(1).max(100).default(1),
  starts_at: z.string().datetime({ offset: true }).nullable().optional(),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  is_active: z.boolean().default(true),
}).strict()
  .refine((v) => v.kind !== 'percent' || v.value <= 10000, { message: 'A percentage cannot exceed 100%', path: ['value'] })
  .refine((v) => !v.starts_at || !v.ends_at || new Date(v.ends_at) > new Date(v.starts_at), { message: 'End must be after start', path: ['ends_at'] });

export const couponPatch = z.object({
  is_active: z.boolean().optional(),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  max_redemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  min_subtotal_minor: money.optional(),
  per_customer_limit: z.number().int().min(1).max(100).optional(),
}).strict();

// ── Cart & orders (storefront) ──────────────────────────────────────────────
/** Prices are never accepted from the browser; unknown keys (e.g. a price) are stripped. */
export const cartAddInput = z.object({
  variant_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(999),
});
export const cartQtyInput = z.object({ quantity: z.number().int().min(1).max(999) });

export const checkoutInput = z.object({
  coupon_code: code.optional(),
  fulfillment_method: z.enum(['pickup', 'with_visit']).default('pickup'),
  booking_id: z.string().uuid().optional(),
  note: z.string().trim().max(500).optional(),
}).refine((v) => v.fulfillment_method !== 'with_visit' || !!v.booking_id, { message: 'Choose the visit to collect with', path: ['booking_id'] });
export type CheckoutInput = z.infer<typeof checkoutInput>;

// ── Orders (dashboard) ──────────────────────────────────────────────────────
export const orderListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum([...ORDER_STATUSES, 'open', 'all']).optional(),
  sort: z.enum(['created', 'total', 'number']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export const orderStatusInput = z.object({ to: z.enum(FULFILLMENT_STEPS) }).strict();
export const orderCancelInput = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const returnInput = z.object({
  reason: z.string().trim().min(3).max(500),
  restock: z.boolean().default(false),
  items: z.array(z.object({ order_item_id: z.string().uuid(), quantity: z.number().int().min(1).max(999) }).strict()).min(1).max(50),
}).strict();
export const returnDecisionInput = z.object({ decision: z.enum(['approved', 'rejected']) }).strict();
