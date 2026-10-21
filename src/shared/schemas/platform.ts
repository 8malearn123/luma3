import { z } from 'zod';
import { PLAN_FEATURES } from '../plans';

/** Shared zod schemas for LUMA administration (/api/v1/platform/**). */
export const PLATFORM_ROLE_VALUES = ['platform_owner', 'support_admin', 'policy_reviewer', 'technical_admin'] as const;

const reason = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const page = { limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(400).optional() };

export const mfaCodeInput = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict();
export const mfaResetInput = z.object({ reason }).strict();

export const tenantListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['onboarding', 'active', 'suspended', 'closed']).optional(),
  plan: z.string().regex(/^[a-z0-9_]{2,32}$/).optional(),
  sub_status: z.enum(['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired']).optional(),
  sort: z.enum(['created_desc', 'created_asc', 'name_asc', 'trial_end_asc']).default('created_desc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const tenantStatusInput = z.object({ status: z.enum(['active', 'suspended']), reason }).strict();

export const userListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  platform_only: z.enum(['0', '1']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const roleChangeInput = z.object({ role: z.enum(PLATFORM_ROLE_VALUES), action: z.enum(['grant', 'revoke']), reason }).strict();

const featureKeys = Object.keys(PLAN_FEATURES) as [keyof typeof PLAN_FEATURES, ...Array<keyof typeof PLAN_FEATURES>];
export const planUpdateInput = z.object({
  version: z.number().int().min(1),
  name_ar: z.string().trim().min(1).max(60).optional(),
  name_en: z.string().trim().min(1).max(60).optional(),
  description_ar: z.string().trim().max(300).nullable().optional(),
  description_en: z.string().trim().max(300).nullable().optional(),
  /** NULL = "pricing not configured". Any number set here is a labelled TEST price unless price_is_test=false. */
  price_monthly_minor: z.number().int().min(0).max(100_000_000).nullable().optional(),
  price_yearly_minor: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  price_is_test: z.boolean().optional(),
  trial_days: z.number().int().min(0).max(90).optional(),
  grace_days: z.number().int().min(0).max(60).optional(),
  status: z.enum(['draft', 'active', 'retired']).optional(),
  sort: z.number().int().min(0).max(100).optional(),
  features: z.array(z.object({
    feature_key: z.enum(featureKeys),
    enabled: z.boolean(),
    limit_value: z.number().int().min(0).max(1_000_000).nullable(),
  }).strict()).max(60).optional(),
}).strict();

export const subscriptionListQuery = z.object({
  status: z.enum(['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired']).optional(),
  trial_ending_days: z.coerce.number().int().min(1).max(60).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const SUBSCRIPTION_ACTIONS = ['activate', 'extend_trial', 'set_grace', 'mark_past_due', 'pause', 'resume', 'cancel', 'expire', 'reactivate', 'change_plan'] as const;
export const subscriptionActionInput = z.object({
  action: z.enum(SUBSCRIPTION_ACTIONS),
  days: z.number().int().min(1).max(90).optional(),
  plan_code: z.string().regex(/^[a-z0-9_]{2,32}$/).optional(),
  reason,
}).strict();
export const invoiceCreateInput = z.object({ note: z.string().trim().max(500).optional() }).strict();
export const invoiceMarkInput = z.object({ action: z.enum(['mark_paid', 'void']), note: z.string().trim().max(500).optional() }).strict();

export const auditQuery = z.object({
  tenant: z.string().trim().max(60).optional(),
  actor: z.string().trim().max(254).optional(),
  action: z.string().trim().regex(/^[a-z0-9_.]{1,80}$/).optional(),
  actor_kind: z.enum(['user', 'platform', 'support', 'system', 'customer', 'anonymous']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sensitive_only: z.enum(['0', '1']).optional(),
  ...page,
});

export const aiUsageQuery = z.object({ months: z.coerce.number().int().min(1).max(12).default(3), q: z.string().trim().max(100).optional() });
export const revenueQuery = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) });

export const templateDocument = z.object({
  layout: z.unknown(),
  pages: z.array(z.object({
    kind: z.enum(['home', 'about', 'services', 'products', 'team', 'contact', 'faq', 'privacy', 'returns', 'booking_policy', 'custom']),
    blocks: z.unknown(),
  }).strict()).min(1).max(12),
}).strict();
export const templateInput = z.object({
  key: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  name_ar: z.string().trim().min(1).max(80),
  name_en: z.string().trim().min(1).max(80),
  description_ar: z.string().trim().max(400).nullable().optional(),
  description_en: z.string().trim().max(400).nullable().optional(),
  business_types: z.array(z.enum(['salon', 'expert', 'beauty_center', 'spa'])).min(1).max(4),
  document: templateDocument,
}).strict();
export const templatePatch = templateInput.omit({ key: true }).partial().extend({ version: z.number().int().min(1) }).strict();
export const templateStatusInput = z.object({ status: z.enum(['draft', 'approved', 'retired']), version: z.number().int().min(1) }).strict();
export const componentInput = z.object({ is_enabled: z.boolean(), min_plan_feature: z.string().regex(/^feature\.[a-z_]+$/).nullable().optional() }).strict();

export const supportGrantInput = z.object({
  tenant_slug: z.string().regex(/^[a-z0-9-]{3,48}$/),
  reason,
  access_level: z.enum(['read', 'write']).default('read'),
  hours: z.number().int().min(1).max(24).default(2),
}).strict();
export const supportRevokeInput = z.object({ reason: z.string().trim().max(300).optional() }).strict();
export const supportListQuery = z.object({ scope: z.enum(['active', 'all']).default('active'), mine: z.enum(['0', '1']).optional() });
