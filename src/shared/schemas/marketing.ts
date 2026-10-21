import { z } from 'zod';

/**
 * Shared contracts for storefront analytics, employee indicators and Loom
 * Marketing (plans, recommendations, trend radar, segments, campaigns).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const money = z.number().int().min(0).max(1_000_000_000);
const shortText = (max: number) => z.string().trim().min(1).max(max);

// ── Storefront analytics ─────────────────────────────────────────────────────
export const ANALYTICS_EVENT_TYPES = [
  'page_view', 'service_view', 'product_view', 'booking_start', 'checkout_start',
  'booking_confirmed', 'order_paid', 'availability_empty', 'waitlist_join',
] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];
/** Conversions are recorded server-side only (recordServerEvent); browsers cannot claim them. */
export const CLIENT_EVENT_TYPES = ANALYTICS_EVENT_TYPES.filter((t) => t !== 'booking_confirmed' && t !== 'order_paid') as unknown as readonly [AnalyticsEventType, ...AnalyticsEventType[]];

const utmValue = z.string().trim().max(100).regex(/^[\p{L}\p{N} _.\-+]*$/u);
export const eventInput = z.object({
  event_id: z.string().uuid(),
  session_id: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  type: z.enum(CLIENT_EVENT_TYPES),
  entity_id: z.string().uuid().optional(),
  path: z.string().max(300).regex(/^\/[^\s<>"]*$/).optional(),
  occurred_at: z.string().datetime({ offset: true }),
  /** Host only is kept; a full URL is reduced to its host server-side. */
  referrer: z.string().max(300).optional(),
  utm: z.object({ source: utmValue.optional(), medium: utmValue.optional(), campaign: utmValue.optional(), content: utmValue.optional(), term: utmValue.optional() }).strict().optional(),
}).strict();
export type EventInput = z.infer<typeof eventInput>;

export const periodQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  staff_id: z.string().uuid().optional(),
}).strict();

export const performanceSettingsInput = z.object({
  weights: z.object({
    satisfaction: z.number().int().min(0).max(100),
    repeat: z.number().int().min(0).max(100),
    punctuality: z.number().int().min(0).max(100),
    complaints: z.number().int().min(0).max(100),
    occupancy: z.number().int().min(0).max(100),
  }).strict().refine((w) => Object.values(w).some((v) => v > 0), 'At least one weight must be positive'),
  min_completed: z.number().int().min(5).max(1000),
  min_reviews: z.number().int().min(3).max(1000),
  min_timed: z.number().int().min(3).max(1000),
  punctuality_grace_min: z.number().int().min(0).max(60),
}).strict();

// ── Loom Marketing: preferences & calendar ───────────────────────────────────
export const MARKETING_CHANNELS = ['email', 'sms', 'whatsapp', 'in_app', 'instagram', 'tiktok', 'snapchat', 'storefront'] as const;
export const preferencesInput = z.object({
  goals: z.array(shortText(200)).max(10),
  monthly_budget_minor: money.nullable(),
  max_discount_bp: z.number().int().min(0).max(10000),
  tone: z.string().trim().max(200).nullable(),
  brand_style: z.string().trim().max(300).nullable(),
  channels: z.array(z.enum(MARKETING_CHANNELS)).max(MARKETING_CHANNELS.length),
  audience_notes: z.string().trim().max(1000).nullable(),
  photography_resources: z.string().trim().max(1000).nullable(),
  schedule_enabled: z.boolean(),
  weekly_enabled: z.boolean(),
  monthly_enabled: z.boolean(),
  weekly_weekday: z.number().int().min(0).max(6),
  monthly_day: z.number().int().min(1).max(28),
  local_hour: z.number().int().min(0).max(23),
  promote_products: z.boolean(),
}).strict();

export const calendarEventInput = z.object({
  title: shortText(120),
  kind: z.enum(['holiday', 'season', 'local_event', 'business_event']),
  starts_on: isoDate,
  ends_on: isoDate,
  relevance_note: z.string().trim().max(500).optional(),
  source_url: z.string().url().max(500).regex(/^https:\/\//).optional(),
}).strict().refine((v) => v.ends_on >= v.starts_on, { message: 'ends_on must be on or after starts_on', path: ['ends_on'] });

// ── Plans ────────────────────────────────────────────────────────────────────
export const PLAN_STATUSES = ['draft', 'proposed', 'under_review', 'approved', 'in_progress', 'completed', 'deferred', 'rejected'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const planActivity = z.object({
  id: z.string().min(1).max(40),
  title: shortText(200),
  initiative_id: z.string().max(40).nullable(),
  date_from: isoDate.nullable(),
  date_to: isoDate.nullable(),
  channel: z.string().max(40).nullable(),
  content_idea: z.string().max(1000).nullable(),
  owner: z.string().max(80).nullable(),
  capacity_note: z.string().max(300).nullable(),
  monthly_goal_ref: z.string().max(40).nullable(),
  status: z.enum(['planned', 'in_progress', 'done', 'skipped']),
}).strict();

export const planContent = z.object({
  goal: shortText(500),
  baseline: z.array(z.object({ metric_key: z.string().max(120), label: z.string().max(200), value: z.number().nullable() }).strict()).max(30),
  initiatives: z.array(z.object({
    id: z.string().min(1).max(40), title: shortText(200), description: z.string().max(1500), evidence_refs: z.array(z.string().max(120)).max(20),
  }).strict()).max(20),
  activities: z.array(planActivity).max(60),
  dates: z.object({ start: isoDate, end: isoDate }).strict(),
  owner: z.string().max(80),
  budget: z.object({ amount_minor: money.nullable(), status: z.enum(['within_budget', 'over_budget', 'unknown', 'no_budget_set']), assumptions: z.string().max(500) }).strict(),
  metrics: z.array(z.object({
    key: z.string().max(120), label: z.string().max(200), baseline: z.number().nullable(),
    /** A proposed target is a goal, not a promise or a forecast. */
    proposed_target: z.number().nullable(),
  }).strict()).max(20),
  monthly_goals: z.array(z.object({ id: z.string().max(40), title: z.string().max(200) }).strict()).max(10),
  experimental: z.boolean(),
  limitations: z.string().max(2000),
}).strict();
export type PlanContent = z.infer<typeof planContent>;

export const createPlanInput = z.object({
  kind: z.enum(['monthly', 'weekly']),
  parent_plan_id: z.string().uuid().optional(),
  period_start: isoDate,
  period_end: isoDate,
  title: shortText(200),
  content: planContent,
}).strict();

export const planVersionInput = z.object({
  base_version: z.number().int().min(1),
  content: planContent,
  change_note: z.string().trim().max(500).optional(),
}).strict();

export const PLAN_ACTIONS = ['propose', 'review', 'approve', 'start', 'complete', 'defer', 'reject', 'reopen'] as const;
export const planTransitionInput = z.object({ action: z.enum(PLAN_ACTIONS), note: z.string().trim().max(500).optional() }).strict();
export const planCommentInput = z.object({ body: shortText(2000), plan_version_id: z.string().uuid().optional() }).strict();

// ── AI jobs ──────────────────────────────────────────────────────────────────
export const AI_JOB_KINDS = ['monthly_plan', 'weekly_plan', 'recommendations', 'trend_assessment', 'employee_insights'] as const;
export const aiJobInput = z.object({
  kind: z.enum(AI_JOB_KINDS),
  /** Optional explicit period start (YYYY-MM-DD); defaults to the next period in the business timezone. */
  period_start: isoDate.optional(),
}).strict();

// ── Recommendations ──────────────────────────────────────────────────────────
export const RECOMMENDATION_CATEGORIES = ['quiet_periods', 'reactivation', 'seasonal', 'service_promotion', 'packages', 'cross_sell',
  'loyalty', 'content', 'pricing', 'booking_experience', 'campaign_review', 'trend'] as const;
export const recommendationDecision = z.object({
  decision: z.enum(['accepted', 'dismissed', 'deferred', 'open']),
  review_at: isoDate.optional(),
  note: z.string().trim().max(500).optional(),
}).strict();
export const pricingProposalFromRecommendation = z.object({
  service_id: z.string().uuid(),
  proposed_price_minor: money,
}).strict();

// ── Trend radar ──────────────────────────────────────────────────────────────
export const trendSourceInput = z.object({
  kind: z.enum(['rss', 'user_link']),
  name: shortText(120),
  url: z.string().url().max(500).regex(/^https:\/\//, 'Only https sources are allowed'),
  access_basis: shortText(300),
}).strict();
export const trendSourcePatch = z.object({ status: z.enum(['active', 'disabled']) }).strict();

// ── Segments ─────────────────────────────────────────────────────────────────
export const CONSENT_CHANNELS = ['email', 'sms', 'whatsapp', 'in_app'] as const;
export const segmentCondition = z.discriminatedUnion('type', [
  z.object({ type: z.literal('last_visit_before_days'), days: z.number().int().min(1).max(1095) }).strict(),
  z.object({ type: z.literal('last_visit_within_days'), days: z.number().int().min(1).max(1095) }).strict(),
  z.object({ type: z.literal('visited_service'), service_id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('not_visited_service'), service_id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('due_for_service'), service_id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('min_visits'), count: z.number().int().min(1).max(1000) }).strict(),
  z.object({ type: z.literal('has_consent'), channel: z.enum(CONSENT_CHANNELS) }).strict(),
  z.object({ type: z.literal('tag'), tag: z.string().trim().min(1).max(60) }).strict(),
  z.object({ type: z.literal('never_booked') }).strict(),
  z.object({ type: z.literal('has_account') }).strict(),
]);
export type SegmentCondition = z.infer<typeof segmentCondition>;
export const segmentDefinition = z.object({ conditions: z.array(segmentCondition).min(1).max(10) }).strict();
export type SegmentDefinition = z.infer<typeof segmentDefinition>;
export const segmentInput = z.object({ name: shortText(120), description: z.string().trim().max(500).optional(), definition: segmentDefinition }).strict();
export const segmentPreviewInput = z.object({ definition: segmentDefinition }).strict();

// ── Campaigns ────────────────────────────────────────────────────────────────
export const CAMPAIGN_CHANNELS = ['email', 'sms', 'whatsapp', 'in_app'] as const;
export const campaignContent = z.object({
  subject: z.string().trim().max(150).optional(),
  body: shortText(1500),
  /** Internal storefront path only (deep link), e.g. /s/my-salon/services/… */
  deep_link: z.string().max(300).regex(/^\/[A-Za-z0-9/_\-?=&.%]*$/).optional(),
}).strict();
export const campaignInput = z.object({
  name: shortText(120),
  channel: z.enum(CAMPAIGN_CHANNELS),
  segment_id: z.string().uuid().nullable(),
  content: campaignContent,
  holdout_bp: z.number().int().min(0).max(5000).default(1000),
  attribution_window_days: z.number().int().min(1).max(90).default(14),
  frequency_cap_days: z.number().int().min(0).max(90).default(7),
  quiet_hours: z.object({ from: hhmm, to: hhmm }).strict().default({ from: '21:00', to: '09:00' }),
  recommendation_id: z.string().uuid().optional(),
  plan_id: z.string().uuid().optional(),
}).strict();
export const campaignPatch = campaignInput.partial().strict();
export const campaignScheduleInput = z.object({ scheduled_at: z.string().datetime({ offset: true }).optional() }).strict();
