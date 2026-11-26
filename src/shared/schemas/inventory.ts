import { z } from 'zod';
import { UNITS } from '../units';

/** Multi-location inventory, transfers, consumption and purchasing inputs. */
const qty3 = z.number().finite().refine((n) => Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6, { message: 'At most 3 decimal places' });
const pos = qty3.pipe(z.number().positive().max(10_000_000));
const money = z.number().int().min(0).max(1_000_000_000);
const cost = z.number().min(0).max(100_000_000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const note = z.string().trim().max(500);

export const LOCATION_KINDS = ['main', 'branch', 'station', 'custody', 'quarantine'] as const;

export const locationInput = z.object({
  branch_id: z.string().uuid().optional(),
  kind: z.enum(['station', 'custody', 'quarantine', 'branch']),
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,32}$/).nullable().optional(),
  staff_id: z.string().uuid().nullable().optional(),
  sort: z.number().int().min(0).max(10_000).optional(),
  /** Station only: the chairs it serves. */
  resource_ids: z.array(z.string().uuid()).max(50).optional(),
}).strict();

export const locationPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,32}$/).nullable().optional(),
  staff_id: z.string().uuid().nullable().optional(),
  sort: z.number().int().min(0).max(10_000).optional(),
  is_active: z.boolean().optional(),
  resource_ids: z.array(z.string().uuid()).max(50).optional(),
}).strict();

export const inventorySettingsInput = z.object({
  transfer_confirmation: z.enum(['immediate', 'confirm_receipt']).optional(),
  expiry_warning_days: z.number().int().min(1).max(365).optional(),
}).strict();

export const balancesQuery = z.object({
  location_id: z.string().uuid().optional(),
  branch_id: z.string().uuid().optional(),
  inventory_item_id: z.string().uuid().optional(),
  nonzero: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const reorderLevelInput = z.object({
  reorder_level: qty3.pipe(z.number().min(0).max(10_000_000)).nullable(),
}).strict();

export const transferInput = z.object({
  from_location_id: z.string().uuid(),
  to_location_id: z.string().uuid(),
  note: note.optional(),
  lines: z.array(z.object({ inventory_item_id: z.string().uuid(), quantity: pos }).strict()).min(1).max(100),
  /** true: dispatch now (immediate mode completes, confirm mode goes in transit). */
  execute: z.boolean().default(true),
}).strict();

export const transferActionInput = z.object({ version: z.number().int().positive().optional() }).strict();

export const issueInput = z.object({
  inventory_item_id: z.string().uuid(),
  location_id: z.string().uuid().optional(),
  quantity: pos,
  unit: z.enum(UNITS).optional(),
  reason: z.string().trim().min(3).max(500),
  staff_id: z.string().uuid().nullable().optional(),
}).strict();

export const usagePlanInput = z.object({
  lines: z.array(z.object({ inventory_item_id: z.string().uuid(), actual_qty: qty3.pipe(z.number().min(0).max(10_000_000)) }).strict()).min(1).max(30),
}).strict();

export const actualUsageInput = z.object({
  actual_qty: qty3.pipe(z.number().min(0).max(10_000_000)),
  reason: z.string().trim().min(3).max(500),
  version: z.number().int().positive(),
}).strict();

export const consumptionWasteInput = z.object({
  quantity: pos,
  reason: z.string().trim().min(3).max(500),
}).strict();

export const taskResolveInput = z.object({
  action: z.enum(['post_remaining', 'write_off', 'dismiss', 'resolve']),
  resolution: z.string().trim().min(3).max(500).optional(),
}).strict();

export const tasksQuery = z.object({
  status: z.enum(['open', 'resolved', 'dismissed', 'all']).default('open'),
  kind: z.enum(['shortage', 'expiry', 'reorder']).optional(),
});

export const reverseInput = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

// ── Purchasing ──────────────────────────────────────────────────────────────
export const supplierInput = z.object({
  name: z.string().trim().min(1).max(160),
  contact_name: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(200).nullable().optional(),
  tax_number: z.string().trim().max(40).nullable().optional(),
  payment_terms_days: z.number().int().min(0).max(365).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  is_active: z.boolean().optional(),
}).strict();
export const supplierPatch = supplierInput.partial().strict();

export const receiptInput = z.object({
  supplier_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().optional(),
  received_on: date,
  reference: z.string().trim().max(80).nullable().optional(),
  note: note.nullable().optional(),
  lines: z.array(z.object({
    inventory_item_id: z.string().uuid(),
    quantity: pos,
    /** 'storage': quantity in the item's storage unit (converted by its approved factor). */
    uom: z.enum(['usage', 'storage']).default('usage'),
    /** Cost per entered unit. */
    unit_cost_minor: cost.nullable().optional(),
    batch_no: z.string().trim().min(1).max(60).nullable().optional(),
    expiry_date: date.nullable().optional(),
  }).strict()).min(1).max(200),
  /** true: post now (adds stock exactly once). */
  post: z.boolean().default(false),
}).strict();

export const invoiceInput = z.object({
  supplier_id: z.string().uuid(),
  invoice_number: z.string().trim().min(1).max(60),
  invoice_date: date,
  due_date: date.nullable().optional(),
  attachment_asset_id: z.string().uuid().nullable().optional(),
  note: note.nullable().optional(),
  lines: z.array(z.object({
    inventory_item_id: z.string().uuid().nullable().optional(),
    description: z.string().trim().max(200).nullable().optional(),
    quantity: pos,
    /** Per base unit of the item (or per unit for non-stock lines). */
    unit_cost_minor: cost,
    discount_minor: money.default(0),
    tax_minor: money.default(0),
    /** Match to received lines (partial allowed). Never adds stock. */
    links: z.array(z.object({ receipt_line_id: z.string().uuid(), quantity: pos }).strict()).max(50).default([]),
  }).strict()).min(1).max(200),
  post: z.boolean().default(false),
}).strict();

export const invoiceLinkInput = z.object({
  invoice_line_id: z.string().uuid(),
  receipt_line_id: z.string().uuid(),
  quantity: pos,
}).strict();

export const voidInput = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const paymentInput = z.object({
  supplier_id: z.string().uuid(),
  invoice_id: z.string().uuid().nullable().optional(),
  amount_minor: z.number().int().positive().max(1_000_000_000),
  method: z.enum(['cash', 'bank']),
  paid_on: date,
  reference: z.string().trim().max(80).nullable().optional(),
  note: note.nullable().optional(),
}).strict();

export const supplierReturnInput = z.object({
  supplier_id: z.string().uuid(),
  location_id: z.string().uuid().optional(),
  reason: z.string().trim().min(3).max(500),
  lines: z.array(z.object({
    inventory_item_id: z.string().uuid(),
    quantity: pos,
    receipt_line_id: z.string().uuid().nullable().optional(),
  }).strict()).min(1).max(100),
}).strict();

export const reportQuery = z.object({
  from: date.optional(),
  to: date.optional(),
  location_id: z.string().uuid().optional(),
  inventory_item_id: z.string().uuid().optional(),
  group: z.enum(['service', 'booking', 'chair', 'performer', 'item', 'location']).optional(),
});
