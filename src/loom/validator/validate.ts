import { checkAwarenessRule } from '../radar/awareness';
import type { CapacityStatus, InventoryStatus, MarginStatus } from '../contracts/opportunity';
import type { PlanDraft } from '../contracts/plan';
import type { NumberDecl, PlannerCard, PlannerInitiative, PlannerOutput } from '../planner/schema';
import { addDays } from '../util/time';
import type { Localized } from '../util/text';

/**
 * Validator v2 (§6.10). Extends the rules of the legacy marketing validator
 * (src/server/domains/marketing/validate.ts) to the Loom planner contract.
 * Pure: everything it needs is in ValidationContext. It REJECTS items (cards,
 * initiatives) or the whole plan; the caller re-asks once with the errors and
 * then falls back to rules wording for whatever is still rejected.
 *
 * | check                                                      | failure                    |
 * |------------------------------------------------------------|----------------------------|
 * | every number traced to ev_/cf_/tr_ evidence or assumption | reject item (T14)          |
 * | plan budget ≤ business budget                              | reject plan                |
 * | checks acknowledged = computed checks                      | reject item                |
 * | preferences: no_discounts, max discount, excluded, tone    | reject item                |
 * | no health / therapeutic claims (AR + EN + sector pack)     | reject item                |
 * | no promotion of full slots                                 | reject item                |
 * | dates only from verified events (or inside the period)     | reject item; event_ref dropped |
 * | review_at present and sensible                             | default today + 14         |
 */
export type ValidationItem = {
  ref: string;
  opportunity_id: string;
  checks: { capacity: CapacityStatus; inventory: InventoryStatus; margin: MarginStatus };
  /** Promotional actions must not run on full slots. */
  promotional: boolean;
  /** Free bookable slots for the item's offering in the plan window (null = not slot-based). */
  free_slots: number | null;
};

export type ValidationContext = {
  today: string;
  period: { from: string; to: string };
  items: ValidationItem[];
  /** Allowed references → value (ev_* evidence, cf_* computed facts, tr_* tool results). */
  refs: Map<string, number | null>;
  prefs: { no_discounts: boolean; max_discount_bp: number; monthly_budget_minor: number | null; excluded_names: string[]; banned_words: string[] };
  /** Spend already committed by code (computed costs of the plan's actions). */
  computed_spend_minor: number;
  forbiddenClaims: RegExp[];
  verifiedEvents: Array<{ ref: string; starts_on: string; ends_on: string }>;
  knowledgeRefs: Set<string>;
  /** Phase 4: event refs that are awareness-only (health days): no discount coupling, no therapeutic claims. */
  awarenessOnlyRefs?: Set<string>;
};

export type ValidationError = { item: string; code: ValidationCode; detail?: string };
export type ValidationCode = 'unsupported_number' | 'unknown_reference' | 'reference_value_mismatch' | 'budget_overflow' | 'checks_inconsistent' | 'discount_not_allowed'
  | 'discount_over_cap' | 'excluded_offering' | 'banned_word' | 'health_claim' | 'full_slot_promotion' | 'unverified_date' | 'unknown_opportunity' | 'missing_checks' | 'awareness_violation';

export type ValidationResult = {
  cards: Map<string, PlannerCard>;
  initiatives: PlannerInitiative[];
  plan_ok: boolean;
  errors: ValidationError[];
  flags: string[];
  /** Numbers the model tagged as assumptions (shown on the card / plan). */
  assumptions: Map<string, number[]>;
};

// Arabic + English therapeutic / medical claim patterns (in addition to the sector pack's).
export const HEALTH_CLAIM_PATTERNS: RegExp[] = [
  /[يت]عالج|معالجة|علاج|[يت]شفي|شفاء|طبي(?!ع)|يزيل (?:حب الشباب|السيلوليت|التجاعيد) نهائي|مضمون|مضمونة/,
  /\b(?:cures?|cured|treats? (?:acne|eczema|hair loss|psoriasis|disease)|treatment for|heals?|medical(?:ly)?|clinically proven|therapeutic|guaranteed|removes? (?:acne|wrinkles|cellulite) permanently)\b/i,
];
export const DISCOUNT_RE = /خصم|تخفيض|تخفيضات|خصومات|discount|% ?off\b|\bsale\b|\bdeal\b/i;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUM_RE = /\d+(?:[.,]\d+)?/g;

export function normalizeDigits(s: string) {
  return s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/٫/g, '.').replace(/٬/g, '');
}

/** Numbers written in a text, ignoring ISO dates (checked separately). Thousands separators are removed. */
export function numbersIn(text: string): number[] {
  const t = normalizeDigits(text).replace(DATE_RE, ' ').replace(/(\d),(\d{3})\b/g, '$1$2');
  return (t.match(NUM_RE) ?? []).map((n) => Number(n.replace(',', '.'))).filter((n) => Number.isFinite(n));
}
export const datesIn = (text: string) => normalizeDigits(text).match(DATE_RE) ?? [];

/** Forms a value may legitimately take in prose: itself, rounded, as a percentage, or in major currency units. */
export function forms(v: number): number[] {
  return [v, Math.round(v), Math.round(v * 10) / 10, Math.round(v * 100) / 100, Math.round(v * 100), Math.round(v * 1000) / 10, v / 100, Math.round(v / 100)];
}
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.005);
const matches = (n: number, v: number) => forms(v).some((f) => close(n, f));

const textsOf = (parts: Array<Localized | null | undefined>) => parts.flatMap((p) => (p ? [p.ar, p.en] : []));

/** Checks one wording item's text and its number declarations. Returns error codes (empty = valid). */
export function checkText(item: string, texts: string[], numbers: NumberDecl[], ctx: ValidationContext, opts: { promotional: boolean; freeSlots: number | null }): { errors: ValidationError[]; assumptions: number[] } {
  const errors: ValidationError[] = [];
  const assumptions: number[] = [];
  // Every declaration must be an assumption or a known reference whose value matches.
  const okDecl: NumberDecl[] = [];
  for (const d of numbers) {
    if (d.assumption) { okDecl.push(d); assumptions.push(d.value); continue; }
    if (!d.evidence_ref || !ctx.refs.has(d.evidence_ref)) { errors.push({ item, code: 'unknown_reference', detail: d.evidence_ref ?? 'null' }); continue; }
    const v = ctx.refs.get(d.evidence_ref);
    if (v === null || v === undefined || !(close(d.value, v) || matches(d.value, v))) { errors.push({ item, code: 'reference_value_mismatch', detail: d.evidence_ref }); continue; }
    okDecl.push(d);
  }
  const joined = texts.join('\n');
  for (const n of numbersIn(joined)) {
    if (!okDecl.some((d) => matches(n, d.value) || close(n, d.value))) { errors.push({ item, code: 'unsupported_number', detail: String(n) }); }
  }
  const verified = new Set(ctx.verifiedEvents.flatMap((e) => [e.starts_on, e.ends_on]));
  for (const d of datesIn(joined)) {
    if (!verified.has(d) && !(d >= ctx.period.from && d <= ctx.period.to)) errors.push({ item, code: 'unverified_date', detail: d });
  }
  const discountWord = DISCOUNT_RE.test(joined);
  if (discountWord && ctx.prefs.no_discounts) errors.push({ item, code: 'discount_not_allowed' });
  else if (discountWord) {
    const cap = ctx.prefs.max_discount_bp / 100;
    const pcts = [...normalizeDigits(joined).matchAll(/(\d+(?:\.\d+)?)\s*(?:%|٪|في المئة|بالمئة|percent)/g)].map((m) => Number(m[1]));
    if (pcts.some((p) => p > cap + 1e-9)) errors.push({ item, code: 'discount_over_cap' });
  }
  const lower = joined.toLowerCase();
  for (const name of ctx.prefs.excluded_names) if (name.trim().length >= 2 && lower.includes(name.toLowerCase())) { errors.push({ item, code: 'excluded_offering', detail: name }); break; }
  for (const w of ctx.prefs.banned_words) if (w.trim() && lower.includes(w.toLowerCase())) { errors.push({ item, code: 'banned_word', detail: w }); break; }
  if ([...HEALTH_CLAIM_PATTERNS, ...ctx.forbiddenClaims].some((re) => re.test(joined))) errors.push({ item, code: 'health_claim' });
  if (opts.promotional && opts.freeSlots === 0) errors.push({ item, code: 'full_slot_promotion' });
  return { errors, assumptions };
}

/** Validates the planner's output against the trusted context. */
export function validatePlannerOutput(out: PlannerOutput, ctx: ValidationContext): ValidationResult {
  const items = new Map(ctx.items.map((i) => [i.ref, i]));
  const errors: ValidationError[] = [];
  const flags: string[] = [];
  const cards = new Map<string, PlannerCard>();
  const assumptions = new Map<string, number[]>();

  for (const c0 of out.cards) {
    const it = items.get(c0.opportunity_ref);
    if (!it) { errors.push({ item: c0.opportunity_ref, code: 'unknown_opportunity' }); continue; }
    let c = c0;
    if (c.event_ref && !ctx.verifiedEvents.some((e) => e.ref === c.event_ref)) { c = { ...c, event_ref: null }; flags.push(`unverified_event_removed:${c0.opportunity_ref}`); }
    const kr = c.knowledge_refs.filter((r) => ctx.knowledgeRefs.has(r));
    if (kr.length !== c.knowledge_refs.length) { flags.push(`unknown_knowledge_ref_removed:${c0.opportunity_ref}`); c = { ...c, knowledge_refs: kr }; }
    const e: ValidationError[] = [];
    const ack = c.checks_acknowledged;
    if (ack.capacity !== it.checks.capacity || ack.inventory !== it.checks.inventory || ack.margin !== it.checks.margin) e.push({ item: c.opportunity_ref, code: 'checks_inconsistent' });
    const t = checkText(c.opportunity_ref, textsOf([c.title, c.why_now, c.action_description, c.draft_content]), c.numbers, ctx, { promotional: it.promotional, freeSlots: it.free_slots });
    e.push(...t.errors);
    if (it.promotional && it.checks.capacity === 'blocked') e.push({ item: c.opportunity_ref, code: 'full_slot_promotion' });
    if (c.event_ref && ctx.awarenessOnlyRefs?.has(c.event_ref)) {
      const aw = checkAwarenessRule({ awareness_only: true, text: textsOf([c.title, c.why_now, c.action_description, c.draft_content]), framing: 'awareness_only' }, { validation: { forbiddenClaims: ctx.forbiddenClaims, awarenessOnlyTopics: [] } });
      for (const v of aw.violations) e.push({ item: c.opportunity_ref, code: 'awareness_violation', detail: v });
    }
    if (e.length) errors.push(...e);
    else { cards.set(c.opportunity_ref, c); if (t.assumptions.length) assumptions.set(c.opportunity_ref, t.assumptions); }
  }

  const initiatives: PlannerInitiative[] = [];
  let proposedSpend = 0;
  for (const i of out.plan.initiatives) {
    const it = items.get(i.opportunity_ref);
    const key = `plan:${i.opportunity_ref}`;
    if (!it) { errors.push({ item: key, code: 'unknown_opportunity' }); continue; }
    const t = checkText(key, textsOf([i.title, i.content_idea]), i.numbers, ctx, { promotional: it.promotional, freeSlots: it.free_slots });
    const e = [...t.errors];
    if (it.promotional && it.checks.capacity === 'blocked') e.push({ item: key, code: 'full_slot_promotion' });
    if (e.length) { errors.push(...e); continue; }
    proposedSpend += i.budget_minor ?? 0;
    initiatives.push(i);
    if (t.assumptions.length) assumptions.set(key, t.assumptions);
  }

  let planOk = true;
  const head = checkText('plan', textsOf([out.plan.title, out.plan.goal, ...out.plan.limitations]), out.plan.numbers, ctx, { promotional: false, freeSlots: null });
  if (head.errors.length) { errors.push(...head.errors); planOk = false; }
  const budget = ctx.prefs.monthly_budget_minor;
  if (budget !== null && ctx.computed_spend_minor + proposedSpend > budget) { errors.push({ item: 'plan', code: 'budget_overflow', detail: `${ctx.computed_spend_minor + proposedSpend}>${budget}` }); planOk = false; }
  return { cards, initiatives, plan_ok: planOk, errors, flags, assumptions };
}

/** Final check of a plan draft (AI or rules): the same contract for both. */
/** prefs.monthly_budget_minor is the cap for THIS plan (a weekly plan gets a quarter of the monthly budget). */
export function validatePlanDraft(d: PlanDraft, ctx: { prefs: { no_discounts: boolean; monthly_budget_minor: number | null } }): ValidationError[] {
  const errors: ValidationError[] = [];
  const total = d.actions.reduce((s, a) => s + (a.budget.amount_minor ?? 0), 0);
  if (ctx.prefs.monthly_budget_minor !== null && total > ctx.prefs.monthly_budget_minor) errors.push({ item: 'plan', code: 'budget_overflow', detail: `${total}>${ctx.prefs.monthly_budget_minor}` });
  for (const a of d.actions) {
    if (!a.operational?.capacity?.status || !a.operational?.inventory?.status) errors.push({ item: a.ref, code: 'missing_checks' });
    if (a.action_kind === 'limited_discount' && ctx.prefs.no_discounts) errors.push({ item: a.ref, code: 'discount_not_allowed' });
    if (a.role === 'initiative' && PROMOTIONAL_KINDS.has(a.action_kind) && a.operational.capacity.status === 'blocked') errors.push({ item: a.ref, code: 'full_slot_promotion' });
    if (a.role === 'initiative' && PROMOTIONAL_KINDS.has(a.action_kind) && a.highlighted.some((h) => h.free_slots === 0)) errors.push({ item: a.ref, code: 'full_slot_promotion' });
  }
  return errors;
}

/** Action kinds that bring customers in (and so need free slots). */
export const PROMOTIONAL_KINDS = new Set(['content', 'package', 'value_add', 'reminder', 'loyalty', 'limited_discount']);

/** review_at must exist and be within (today, today + 120]; otherwise today + 14. */
export function ensureReviewAt(v: string | null | undefined, today: string): string {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && v > today && v <= addDays(today, 120)) return v;
  return addDays(today, 14);
}
