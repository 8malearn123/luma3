import { z } from 'zod';

const itemKey = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
export const requestedItem = z.object({
  key: itemKey,
  service_id: z.string().uuid(),
  variant_id: z.string().uuid().nullable().optional(),
  addon_ids: z.array(z.string().uuid()).max(10).optional(),
  staff_id: z.string().uuid().nullable().optional(),
}).strict();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const availabilityInput = z.object({
  branch_id: z.string().uuid().nullable().optional(),
  items: z.array(requestedItem).min(1).max(6),
  from: date,
  to: date,
}).strict();

export const holdInput = z.object({
  branch_id: z.string().uuid().nullable().optional(),
  items: z.array(requestedItem.extend({ staff_id: z.string().uuid(), start: z.string().datetime({ offset: true }) })).min(1).max(6),
  customer_note: z.string().trim().max(500).optional(),
}).strict();

export const staffBookingInput = holdInput.extend({
  customer_id: z.string().uuid(),
  internal_note: z.string().trim().max(1000).optional(),
  /** confirm_on_site: confirm now and collect at the salon (if the customer's terms allow); hold_only: keep a hold for online payment. */
  mode: z.enum(['confirm_on_site', 'hold_only']).default('confirm_on_site'),
}).strict();

export const transitionInput = z.object({
  action: z.enum(['approve', 'reject', 'check_in', 'start', 'complete', 'no_show', 'cancel']),
  reason: z.string().trim().max(500).optional(),
  version: z.number().int().min(1).optional(),
}).strict();

export const rescheduleInput = z.object({
  items: holdInput.shape.items,
  accept_total_minor: z.number().int().min(0).optional(),
}).strict();

export const checkoutInput = z.object({ option: z.enum(['full', 'deposit', 'on_site']) }).strict();

export const onSitePaymentInput = z.object({
  booking_id: z.string().uuid().optional(),
  order_id: z.string().uuid().optional(),
  amount_minor: z.number().int().positive().max(100_000_000),
  method: z.enum(['cash', 'pos_terminal']),
  reference: z.string().trim().min(2).max(80),
}).strict();

export const refundInput = z.object({
  payment_id: z.string().uuid(),
  amount_minor: z.number().int().positive().max(100_000_000),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const listBookingsQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  status: z.string().max(200).optional(),
  staff_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(300).optional(),
});
