import { z } from 'zod';

const txt = (n: number) => z.string().trim().max(n);
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const INCIDENT_TYPES = ['no_show', 'late_cancellation', 'payment_dispute', 'conduct', 'other'] as const;
export const INCIDENT_STATUSES = ['submitted', 'under_review', 'confirmed', 'rejected', 'corrected'] as const;
export const TENANT_ACTIONS = ['default', 'require_deposit', 'require_full_payment', 'manual_approval'] as const;
export const PLATFORM_ACTIONS = [...TENANT_ACTIONS, 'suspend_account'] as const;
export const RULE_ACTIONS = ['require_deposit', 'require_full_payment', 'manual_approval'] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type PolicyAction = (typeof PLATFORM_ACTIONS)[number];

/** Allowed review transitions (reviewers only; every transition needs a note). */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  submitted: ['under_review', 'confirmed', 'rejected'],
  under_review: ['confirmed', 'rejected'],
  confirmed: ['corrected', 'rejected'],
  corrected: ['rejected'],
  rejected: [],
};

export const incidentCreate = z.object({
  booking_id: z.string().uuid().optional().nullable(),
  tenant_customer_id: z.string().uuid().optional().nullable(),
  type: z.enum(INCIDENT_TYPES),
  description: txt(2000).min(5),
  occurred_at: instant.optional(),
  evidence: z.array(z.object({ asset_id: z.string().uuid().optional(), note: txt(500).optional() }).strict()
    .refine((e) => !!(e.asset_id || e.note), { message: 'asset_id or note required' })).max(10).default([]),
}).strict().refine((v) => !!(v.booking_id || v.tenant_customer_id), { message: 'booking_id or tenant_customer_id required', path: ['booking_id'] });

export const incidentListQuery = z.object({
  status: z.enum([...INCIDENT_STATUSES, 'all']).default('all'),
  type: z.enum(INCIDENT_TYPES).optional(),
  tenant_customer_id: z.string().uuid().optional(),
  escalated: z.enum(['0', '1']).optional(),
  q: txt(100).optional(),
  sort: z.enum(['recent', 'occurred']).default('recent'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const incidentTransition = z.object({
  to: z.enum(['under_review', 'confirmed', 'rejected', 'corrected']),
  note: txt(2000).min(3),
  /** Corrections may fix the factual description; the previous text stays in the audit log. */
  corrected_description: txt(2000).min(5).optional(),
}).strict();

export const incidentEscalate = z.object({ note: txt(1000).min(3) }).strict();
export const incidentEvidenceInput = z.object({ asset_id: z.string().uuid().optional(), note: txt(500).optional() }).strict()
  .refine((e) => !!(e.asset_id || e.note), { message: 'asset_id or note required' });

export const evidenceRef = z.object({
  type: z.enum(['incident', 'asset', 'note']),
  id: z.string().uuid().optional(),
  note: txt(500).optional(),
}).strict().refine((r) => (r.type === 'note' ? !!r.note : !!r.id), { message: 'id required (note for type=note)' });

const decisionBase = {
  reason: txt(2000).min(5),
  customer_explanation_ar: txt(600).optional().nullable(),
  customer_explanation_en: txt(600).optional().nullable(),
  evidence_refs: z.array(evidenceRef).max(20).default([]),
  effective_at: instant.optional(),
  expires_at: instant.optional().nullable(),
  review_at: instant.optional().nullable(),
  supersedes_id: z.string().uuid().optional().nullable(),
  rule_id: z.string().uuid().optional().nullable(),
  is_experimental: z.boolean().default(false),
};

export const tenantDecisionCreate = z.object({
  tenant_customer_id: z.string().uuid(),
  action: z.enum(TENANT_ACTIONS),
  ...decisionBase,
}).strict();

export const platformDecisionCreate = z.object({
  customer_user_id: z.string().uuid(),
  action: z.enum(PLATFORM_ACTIONS),
  /** Escalated incident this decision resolves (marks the escalation as decided). */
  incident_id: z.string().uuid().optional().nullable(),
  ...decisionBase,
}).strict();

export const decisionEnd = z.object({ kind: z.enum(['revoke', 'expire']), reason: txt(1000).min(3) }).strict();

export const decisionListQuery = z.object({
  status: z.enum(['active', 'superseded', 'revoked', 'expired', 'all']).default('active'),
  tenant_customer_id: z.string().uuid().optional(),
  customer_user_id: z.string().uuid().optional(),
  action: z.enum(PLATFORM_ACTIONS).optional(),
  review_due: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

/** Rule criteria. No threshold is pre-approved: reviewers configure them and rules stay experimental by default. */
export const ruleCriteria = z.object({
  incident_type: z.enum(INCIDENT_TYPES).optional(),
  min_confirmed: z.number().int().min(1).max(100),
  window_days: z.number().int().min(1).max(730),
}).strict();

export const ruleCreate = z.object({
  key: z.string().trim().regex(/^[a-z0-9_.-]{2,60}$/),
  description: txt(500).optional().nullable(),
  criteria: ruleCriteria,
  suggested_action: z.enum(RULE_ACTIONS),
  is_enabled: z.boolean().default(true),
  is_experimental: z.boolean().default(true),
}).strict();

export const rulePatch = z.object({
  version: z.number().int().min(1),
  description: txt(500).optional().nullable(),
  criteria: ruleCriteria.optional(),
  suggested_action: z.enum(RULE_ACTIONS).optional(),
  is_enabled: z.boolean().optional(),
  is_experimental: z.boolean().optional(),
}).strict();

export const appealCreate = z.object({
  decision_id: z.string().uuid().optional().nullable(),
  incident_id: z.string().uuid().optional().nullable(),
  message: txt(2000).min(10),
}).strict().refine((v) => !!v.decision_id !== !!v.incident_id, { message: 'exactly one of decision_id or incident_id', path: ['decision_id'] });

export const appealResolve = z.object({
  outcome: z.enum(['under_review', 'accepted', 'rejected']),
  /** Shown to the customer. Must not mention other customers or staff. */
  resolution_note: txt(1000).min(3),
  /**
   * For an accepted appeal on a decision: replace it with a milder action
   * (correction) instead of revoking it. Omit to revoke.
   */
  corrected_action: z.enum(TENANT_ACTIONS).optional(),
}).strict();

export const appealListQuery = z.object({
  status: z.enum(['submitted', 'under_review', 'accepted', 'rejected', 'withdrawn', 'open', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const escalationDismiss = z.object({ note: txt(1000).min(3) }).strict();

export const paymentTermsPreviewQuery = z.object({
  tenant_customer_id: z.string().uuid(),
  amount_minor: z.coerce.number().int().min(0).max(100_000_000),
  context: z.enum(['booking', 'order']).default('booking'),
});

export const auditQuery = z.object({
  target_type: z.enum(['incident', 'policy_decision', 'appeal', 'policy_rule']),
  target_id: z.string().uuid(),
});
