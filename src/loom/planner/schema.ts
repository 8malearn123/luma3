import { z } from 'zod';

/**
 * Strict JSON output of the LLM planner (§6.9). The model only WORDS cards
 * and plans: structure, numbers, budgets, checks and slots come from code.
 * Any number written in text must be declared in `numbers` with an evidence
 * reference (ev_* evidence, cf_* computed fact, tr_* read-tool result) or be
 * tagged as an assumption (T14). Unknown fields are rejected.
 */
const s = (n: number) => z.string().max(n);
export const locText = (n: number) => z.object({ ar: s(n), en: s(n) }).strict();

export const numberDecl = z.object({
  value: z.number(),
  evidence_ref: s(60).nullable(),
  assumption: z.boolean(),
}).strict();
export type NumberDecl = z.infer<typeof numberDecl>;

export const CHECK_ENUMS = {
  capacity: ['ok', 'constrained', 'blocked', 'unknown'] as const,
  inventory: ['ok', 'constrained', 'reorder_needed', 'no_recipe', 'not_applicable'] as const,
  margin: ['ok', 'thin', 'negative', 'costs_incomplete', 'not_applicable'] as const,
};

export const plannerCard = z.object({
  opportunity_ref: s(10),
  title: locText(200),
  why_now: locText(600),
  action_description: locText(800),
  draft_content: locText(1000).nullable(),
  numbers: z.array(numberDecl).max(20),
  checks_acknowledged: z.object({ capacity: z.enum(CHECK_ENUMS.capacity), inventory: z.enum(CHECK_ENUMS.inventory), margin: z.enum(CHECK_ENUMS.margin) }).strict(),
  knowledge_refs: z.array(s(100)).max(5),
  event_ref: s(80).nullable(),
}).strict();
export type PlannerCard = z.infer<typeof plannerCard>;

export const plannerInitiative = z.object({
  opportunity_ref: s(10),
  title: locText(200),
  content_idea: locText(1000).nullable(),
  /** Optional proposed spend (an assumption); checked against the business budget. */
  budget_minor: z.number().int().min(0).nullable(),
  numbers: z.array(numberDecl).max(20),
}).strict();
export type PlannerInitiative = z.infer<typeof plannerInitiative>;

export const plannerPlan = z.object({
  title: locText(200),
  goal: locText(500),
  initiatives: z.array(plannerInitiative).max(10),
  limitations: z.array(locText(400)).max(5),
  numbers: z.array(numberDecl).max(20),
}).strict();
export type PlannerPlan = z.infer<typeof plannerPlan>;

export const READ_TOOLS = ['get_metric', 'get_segment_size', 'get_capacity'] as const;
export const toolRequest = z.object({
  tool: z.enum(READ_TOOLS),
  metric_key: s(120).nullable(),
  grain_ref: s(120).nullable(),
  offering_ref: s(10).nullable(),
  segment: z.object({
    conditions: z.array(z.object({
      type: z.enum(['due_for_offering', 'visited_offering', 'not_visited_offering', 'last_visit_before_days']),
      offering_ref: s(10).nullable(),
      days: z.number().int().min(1).max(730).nullable(),
    }).strict()).min(1).max(4),
  }).strict().nullable(),
  window: z.object({ from: s(10), to: s(10) }).strict().nullable(),
}).strict();
export type ToolRequest = z.infer<typeof toolRequest>;

export const plannerOutput = z.object({
  /** Non-empty only when the model needs a detail; answered once, then the model must finish. */
  tool_requests: z.array(toolRequest).max(3),
  cards: z.array(plannerCard).max(8),
  plan: plannerPlan,
}).strict();
export type PlannerOutput = z.infer<typeof plannerOutput>;
