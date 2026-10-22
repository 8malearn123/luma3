import { z } from 'zod';

const txt = (n: number) => z.string().trim().max(n);

export const CONSENT_CHANNELS = ['email', 'sms', 'whatsapp', 'push'] as const;
export const CONSENT_PURPOSES = ['marketing', 'waitlist', 'reminders'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** Business-local preferences: a small, defined document (no free-form sensitive data). */
export const customerPreferences = z.object({
  preferred_staff_ids: z.array(z.string().uuid()).max(10).optional(),
  preferred_contact: z.enum(['phone', 'sms', 'whatsapp', 'email']).optional(),
  language: z.enum(['ar', 'en']).optional(),
  note: txt(300).optional(),
}).strict();

const tag = z.string().trim().min(1).max(40).regex(/^[^<>]+$/);

export const customerListQuery = z.object({
  q: txt(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  tag: tag.optional(),
  source: z.enum(['storefront', 'dashboard', 'walk_in', 'import']).optional(),
  sort: z.enum(['name', 'recent', 'last_visit', 'created']).default('recent'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

/**
 * Walk-in / dashboard customer. Never looks up or links a LUMA account by phone
 * or email: the relationship stays local until the person books with her own account.
 */
export const customerCreate = z.object({
  display_name: txt(120).min(1),
  phone: txt(30).optional().nullable(),
  email: z.string().trim().toLowerCase().email().max(254).optional().nullable(),
  tags: z.array(tag).max(20).default([]),
  preferences: customerPreferences.default({}),
  private_notes: txt(4000).optional().nullable(),
  source: z.enum(['dashboard', 'walk_in']).default('walk_in'),
}).strict();

export const customerPatch = z.object({
  version: z.number().int().min(1),
  display_name: txt(120).min(1).optional(),
  phone: txt(30).optional().nullable(),
  email: z.string().trim().toLowerCase().email().max(254).optional().nullable(),
  tags: z.array(tag).max(20).optional(),
  preferences: customerPreferences.optional(),
  private_notes: txt(4000).optional().nullable(),
  archived: z.boolean().optional(),
}).strict();

export const consentInput = z.object({
  channel: z.enum(CONSENT_CHANNELS),
  purpose: z.enum(CONSENT_PURPOSES).default('marketing'),
  granted: z.boolean(),
}).strict();

export const accountConsentInput = consentInput.extend({ tenant_customer_id: z.string().uuid() }).strict();

export const accountProfilePatch = z.object({
  display_name: txt(120).min(1).optional(),
  locale: z.enum(['ar', 'en']).optional(),
  time_format: z.enum(['12h', '24h']).optional(),
}).strict();

export const reviewInput = z.object({
  booking_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  comment: txt(2000).optional().nullable(),
}).strict();

export const reviewReply = z.object({ reply: txt(1000).min(1).nullable() }).strict();
export const reviewModeration = z.object({
  status: z.enum(['published', 'hidden', 'flagged']),
  reason: txt(500).min(3),
}).strict();
export const reviewListQuery = z.object({
  status: z.enum(['published', 'hidden', 'flagged', 'all']).default('all'),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const unsubscribeInput = z.object({ token: z.string().min(20).max(1000) }).strict();
