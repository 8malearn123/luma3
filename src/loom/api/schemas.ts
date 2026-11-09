import { z } from 'zod';
import { CHANNELS, DECISION_REASONS, OPPORTUNITY_CATEGORIES, OPPORTUNITY_STATUSES } from '../contracts/opportunity';
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
  z.object({
    action: z.literal('approve'), note: z.string().trim().max(1000).optional(),
    /** Edit + approve (§10.1): the edits are kept as a diff on the initiative record. */
    edits: z.object({
      description: z.string().trim().min(1).max(1500).optional(),
      channel: z.array(z.enum(CHANNELS)).min(1).max(4).optional(),
      period: z.object({ from: isoDate, to: isoDate }).strict().refine((p) => p.to >= p.from, { message: 'to before from' }).optional(),
    }).strict().optional(),
  }).strict(),
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

// ── Phase 5: memory and measurement ─────────────────────────────────────────
/** POST opportunities/{id}/feedback — `viewed` (usage) or a like/dislike reaction (taste, never an outcome). */
export const feedbackInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('viewed') }).strict(),
  z.object({ kind: z.literal('reaction'), reaction: z.enum(['like', 'dislike', 'none']) }).strict(),
]);

export const initiativeListQuery = z.object({
  status: z.enum(['scheduled', 'executing', 'completed', 'measured', 'closed', 'cancelled']).optional(),
}).strict();

/** POST initiatives/{id}/executions — what was actually done (manual entry). */
export const executionInput = z.object({
  executed_from: isoDate,
  executed_to: isoDate,
  audience_size: z.number().int().min(0).max(10_000_000).nullable().optional(),
  channel: z.enum(CHANNELS).nullable().optional(),
  actual_cost_minor: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
}).strict().refine((v) => v.executed_to >= v.executed_from, { message: 'executed_to before executed_from', path: ['executed_to'] });

export const decisionsQuery = z.object({
  opportunity_id: z.string().uuid().optional(),
  initiative_id: z.string().uuid().optional(),
}).strict();
