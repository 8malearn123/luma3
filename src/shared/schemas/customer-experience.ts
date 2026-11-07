import { z } from 'zod';
import { HEARD_FROM } from '../acquisition';

/** Owner setting: when to ask for a review after the visit (off / immediately / N hours) and one optional reminder. */
export const reviewRequestSettingsInput = z.object({
  review_request_mode: z.enum(['off', 'immediately', 'after_hours']),
  review_request_delay_hours: z.number().int().min(1).max(168).default(3),
  review_reminder_hours: z.number().int().min(1).max(336).nullable().default(null),
  version: z.number().int().min(1),
}).strict();

export const GIFT_TEMPLATE_KEYS = ['classic', 'floral', 'minimal', 'celebration'] as const;

/**
 * Online gift card purchase with direct send. The recipient gets the code on her
 * phone and/or email at the chosen time (immediately when send_at is omitted).
 */
export const giftCardPurchaseInput = z.object({
  amount_minor: z.number().int().min(1000).max(1_000_000),
  template_key: z.enum(GIFT_TEMPLATE_KEYS).default('classic'),
  recipient_name: z.string().trim().min(1).max(80),
  recipient_phone: z.string().trim().max(20).optional(),
  recipient_email: z.string().trim().toLowerCase().email().max(254).optional(),
  message: z.string().trim().max(300).optional(),
  send_at: z.string().datetime({ offset: true }).optional(),
}).strict().refine((v) => !!v.recipient_phone || !!v.recipient_email, { message: 'Enter the recipient’s mobile number or email', path: ['recipient_phone'] });

export const membershipPurchaseInput = z.object({ plan_id: z.string().uuid() }).strict();

export const acquisitionAnswerInput = z.object({ source: z.enum(HEARD_FROM) }).strict();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const acquisitionReportQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();
