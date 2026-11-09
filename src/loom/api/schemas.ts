import { z } from 'zod';
import { DECISION_REASONS, OPPORTUNITY_CATEGORIES, OPPORTUNITY_STATUSES } from '../contracts/opportunity';
import { EXPLICIT_FACTS, GOAL_KINDS } from '../profile/facts';

/** Loom API v1 request schemas (shared by the routes and the UI). */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const goalsInput = z.object({
  goals: z.array(z.object({
    kind: z.enum(GOAL_KINDS), priority: z.enum(['primary', 'secondary']), offering_ids: z.array(z.string().uuid()).max(20).default([]), note: z.string().trim().max(300).nullable().default(null),
  }).strict()).max(8).refine((g) => g.filter((x) => x.priority === 'primary').length <= 2, { message: 'at most two primary goals' }),
}).strict();

export const preferencesInput = z.object({
  monthly_budget_minor: EXPLICIT_FACTS['pref.monthly_budget_minor'].optional(),
  no_discounts: z.boolean().optional(),
  max_discount_bp: EXPLICIT_FACTS['pref.max_discount_bp'].optional(),
  excluded_offerings: EXPLICIT_FACTS['pref.excluded_offerings'].optional(),
  growth_offerings: EXPLICIT_FACTS['pref.growth_offerings'].optional(),
  tone: EXPLICIT_FACTS['pref.tone'].optional(),
  ranking_weights: EXPLICIT_FACTS['pref.ranking_weights'].optional(),
}).strict();

/** The setup checklist: every provided item becomes "confirmed" (an explicit fact). */
export const setupInput = preferencesInput.extend({
  goals: goalsInput.shape.goals.optional(),
  discount_policy: z.object({ no_discounts: z.boolean(), max_discount_bp: EXPLICIT_FACTS['pref.max_discount_bp'] }).strict().optional(),
  offerings_scope: z.object({ excluded: EXPLICIT_FACTS['pref.excluded_offerings'], growth: EXPLICIT_FACTS['pref.growth_offerings'] }).strict().optional(),
  /** Owner only (business.manage): consent to use this business's anonymised aggregates for sector models. */
  shared_training_consent: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'empty' });

export const profilePatchInput = z.object({
  facts: z.record(z.string().max(120), z.unknown()).refine((f) => Object.keys(f).length > 0 && Object.keys(f).length <= 20, { message: '1–20 facts' }),
}).strict();

export const opportunityListQuery = z.object({
  status: z.enum(OPPORTUNITY_STATUSES).optional(),
  category: z.enum(OPPORTUNITY_CATEGORIES).optional(),
  bucket: z.enum(['top', 'study', 'blocked']).optional(),
  open: z.enum(['1', '0']).optional(),
}).strict();

export const decisionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), note: z.string().trim().max(1000).optional() }).strict(),
  z.object({ action: z.literal('study'), note: z.string().trim().max(1000).optional() }).strict(),
  z.object({ action: z.literal('defer'), reason: z.enum(DECISION_REASONS), until: isoDate, note: z.string().trim().max(1000).optional() }).strict(),
  z.object({ action: z.literal('dismiss'), reason: z.enum(DECISION_REASONS), note: z.string().trim().max(1000).optional() }).strict()
    .refine((v) => v.reason !== 'other' || !!v.note, { message: 'a note is required for "other"', path: ['note'] }),
  z.object({ action: z.literal('reopen'), note: z.string().trim().max(1000).optional() }).strict(),
]);

export const convertInput = z.discriminatedUnion('target', [
  z.object({ target: z.literal('plan_action') }).strict(),
  z.object({ target: z.literal('campaign_draft'), channel: z.enum(['in_app', 'email', 'sms', 'whatsapp']).optional() }).strict(),
  z.object({ target: z.literal('price_proposal'), proposed_price_minor: z.number().int().min(0).max(100_000_000) }).strict(),
]);
export type ConvertInput = z.infer<typeof convertInput>;
