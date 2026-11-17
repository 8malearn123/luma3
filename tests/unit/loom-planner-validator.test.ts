import { describe, expect, it } from 'vitest';
import { beautyPack, ensureReviewAt, validatePlanDraft, validatePlannerOutput, type PlanDraft, type PlannerOutput, type ValidationContext } from '@/loom';

/** Validator v2 (§6.10): pure rejections against a trusted context. */
const ctx = (over: Partial<ValidationContext> = {}, prefs: Partial<ValidationContext['prefs']> = {}): ValidationContext => ({
  today: '2026-11-09',
  period: { from: '2026-11-01', to: '2026-11-30' },
  items: [
    { ref: 'O1', opportunity_id: 'o1', checks: { capacity: 'ok', inventory: 'not_applicable', margin: 'ok' }, promotional: true, free_slots: 12 },
    { ref: 'O2', opportunity_id: 'o2', checks: { capacity: 'blocked', inventory: 'no_recipe', margin: 'ok' }, promotional: true, free_slots: 0 },
  ],
  refs: new Map([['ev_aaaaaaaaaa', 25], ['cf_o1_segment', 40], ['ev_ratio00000', 0.18]]),
  prefs: { no_discounts: false, max_discount_bp: 1500, monthly_budget_minor: 100_000, excluded_names: ['Laser Hair Removal', 'ليزر'], banned_words: ['رخيص'], ...prefs },
  computed_spend_minor: 0,
  forbiddenClaims: beautyPack.validation.forbiddenClaims,
  verifiedEvents: [{ ref: 'calendar:1', starts_on: '2026-12-10', ends_on: '2026-12-12' }],
  knowledgeRefs: new Set(['pb.quiet_capacity.targeted_reminder@1']),
  ...over,
});

const card = (over: Record<string, unknown> = {}) => ({
  opportunity_ref: 'O1',
  title: { ar: 'تذكير بالأوقات الهادئة', en: 'Quiet-time reminder' },
  why_now: { ar: 'أكملنا 25 خدمة', en: 'We completed 25 services' },
  action_description: { ar: 'رسالة ودية', en: 'A friendly message' },
  draft_content: null,
  numbers: [{ value: 25, evidence_ref: 'ev_aaaaaaaaaa', assumption: false }],
  checks_acknowledged: { capacity: 'ok', inventory: 'not_applicable', margin: 'ok' },
  knowledge_refs: ['pb.quiet_capacity.targeted_reminder@1'],
  event_ref: null,
  ...over,
});
const out = (cards: unknown[], plan: Record<string, unknown> = {}): PlannerOutput => ({
  tool_requests: [], cards: cards as PlannerOutput['cards'],
  plan: { title: { ar: 'خطة', en: 'Plan' }, goal: { ar: 'هدف', en: 'Goal' }, initiatives: [], limitations: [], numbers: [], ...plan },
});
const codes = (o: PlannerOutput, c = ctx()) => validatePlannerOutput(o, c).errors.map((e) => e.code);

describe('validator v2', () => {
  it('accepts traced numbers (evidence and percentage forms) and known refs', () => {
    const r = validatePlannerOutput(out([card(), card({ why_now: { ar: 'نسبة ١٨٪', en: '18% share' }, numbers: [{ value: 0.18, evidence_ref: 'ev_ratio00000', assumption: false }] })]), ctx());
    expect(r.errors).toEqual([]);
    expect(r.cards.has('O1')).toBe(true);
  });

  it('rejects a number without an evidence reference (T14) and accepts it when tagged as an assumption', () => {
    expect(codes(out([card({ why_now: { ar: 'زيادة 37%', en: 'A 37% rise' }, numbers: [] })]))).toContain('unsupported_number');
    expect(codes(out([card({ why_now: { ar: 'زيادة ٣٧٪', en: 'A 37% rise' }, numbers: [] })]))).toContain('unsupported_number'); // Arabic-Indic digits
    expect(codes(out([card({ numbers: [{ value: 26, evidence_ref: 'ev_aaaaaaaaaa', assumption: false }] })]))).toEqual(expect.arrayContaining(['reference_value_mismatch', 'unsupported_number']));
    expect(codes(out([card({ numbers: [{ value: 25, evidence_ref: 'ev_unknown000', assumption: false }] })]))).toContain('unknown_reference');
    const r = validatePlannerOutput(out([card({ why_now: { ar: 'زيادة 37%', en: 'A 37% rise' }, numbers: [{ value: 37, evidence_ref: null, assumption: true }] })]), ctx());
    expect(r.errors).toEqual([]);
    expect(r.assumptions.get('O1')).toEqual([37]);
  });

  it('rejects a plan whose budget exceeds the business budget', () => {
    const o = out([card()], { initiatives: [{ opportunity_ref: 'O1', title: { ar: 'مبادرة', en: 'Initiative' }, content_idea: null, budget_minor: 80_000, numbers: [] }] });
    const r = validatePlannerOutput(o, ctx({ computed_spend_minor: 30_000 }));
    expect(r.plan_ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('budget_overflow');
    expect(validatePlannerOutput(o, ctx({ computed_spend_minor: 10_000 })).plan_ok).toBe(true);
  });

  it('rejects discounts under no_discounts and above the cap', () => {
    const disc = card({ action_description: { ar: 'خصم 10% لأسبوع', en: '10% discount for a week' }, numbers: [...card().numbers, { value: 10, evidence_ref: null, assumption: true }] });
    expect(codes(out([disc]), ctx({}, { no_discounts: true, max_discount_bp: 0 }))).toContain('discount_not_allowed');
    expect(codes(out([disc]))).toEqual([]);
    const big = card({ action_description: { ar: 'خصم 30%', en: '30% discount' }, numbers: [...card().numbers, { value: 30, evidence_ref: null, assumption: true }] });
    expect(codes(out([big]))).toContain('discount_over_cap');
  });

  it('rejects excluded offerings and banned tone words', () => {
    expect(codes(out([card({ title: { ar: 'عرض الليزر', en: 'Laser Hair Removal week' } })]))).toContain('excluded_offering');
    expect(codes(out([card({ title: { ar: 'سعر رخيص', en: 'Low price' } })]))).toContain('banned_word');
  });

  it('rejects health and therapeutic claims (Arabic and English)', () => {
    expect(codes(out([card({ action_description: { ar: 'جلسة تعالج حب الشباب', en: 'A session' } })]))).toContain('health_claim');
    expect(codes(out([card({ action_description: { ar: 'جلسة', en: 'Clinically proven to cure acne' } })]))).toContain('health_claim');
    expect(codes(out([card({ action_description: { ar: 'جلسة', en: 'Guaranteed results' } })]))).toContain('health_claim');
    // "natural" (طبيعي) is not a medical claim.
    expect(codes(out([card({ action_description: { ar: 'مظهر طبيعي ونضارة', en: 'A natural, fresh look' } })]))).toEqual([]);
  });

  it('rejects promotion of full slots and inconsistent checks', () => {
    const full = card({ opportunity_ref: 'O2', numbers: [card().numbers[0]], checks_acknowledged: { capacity: 'blocked', inventory: 'no_recipe', margin: 'ok' } });
    expect(codes(out([full]))).toContain('full_slot_promotion');
    expect(codes(out([card({ checks_acknowledged: { capacity: 'blocked', inventory: 'not_applicable', margin: 'ok' } })]))).toContain('checks_inconsistent');
  });

  it('rejects unverified dates and drops unverified event refs', () => {
    expect(codes(out([card({ why_now: { ar: 'قبل 2026-12-25', en: 'Before 2026-12-25' }, numbers: [] })]))).toContain('unverified_date');
    expect(codes(out([card({ why_now: { ar: 'قبل 2026-12-10', en: 'Before 2026-12-10' }, numbers: [] })]))).toEqual([]);
    const r = validatePlannerOutput(out([card({ event_ref: 'calendar:999', knowledge_refs: ['pb.unknown.x@1'] })]), ctx());
    expect(r.cards.get('O1')!.event_ref).toBeNull();
    expect(r.cards.get('O1')!.knowledge_refs).toEqual([]);
    expect(r.flags.some((f) => f.startsWith('unverified_event_removed'))).toBe(true);
  });

  it('review_at is defaulted to today + 14 when missing or absurd', () => {
    expect(ensureReviewAt(null, '2026-11-09')).toBe('2026-11-23');
    expect(ensureReviewAt('2030-01-01', '2026-11-09')).toBe('2026-11-23');
    expect(ensureReviewAt('2026-11-20', '2026-11-09')).toBe('2026-11-20');
  });

  it('checks the final plan draft (AI or rules): budget, discounts, full slots, checks present', () => {
    const action = (over: Partial<PlanDraft['actions'][number]> = {}): PlanDraft['actions'][number] => ({
      ref: 'la_1', seq: 1, opportunity_id: 'o1', role: 'initiative', action_kind: 'reminder', intervention_id: 'targeted_reminder', title: { ar: 'x', en: 'x' }, description: { ar: 'x', en: 'x' },
      content_idea: null, audience: { definition: {}, size: null, size_status: 'unknown', label: { ar: '', en: '' } }, channels: ['in_app'], schedule: { from: '2026-11-10', to: '2026-11-20' },
      owner: { ar: 'المالكة', en: 'Owner' }, budget: { amount_minor: 60_000, basis: 'computed' },
      operational: { capacity: { status: 'ok', max_additional: 3, note: { ar: '', en: '' } }, inventory: { status: 'ok', covers_n: 9, note: null }, requirements: [] },
      highlighted: [], success_metrics: [{ metric_key: 'sales.completed_count', baseline: 1, target: null, target_kind: 'proposed_goal' }], evidence_refs: [], knowledge_refs: [], ...over,
    });
    const draft = (actions: PlanDraft['actions']) => ({ actions } as PlanDraft);
    const prefs = { no_discounts: true, monthly_budget_minor: 100_000 };
    expect(validatePlanDraft(draft([action(), action({ ref: 'la_2' })]), { prefs }).map((e) => e.code)).toContain('budget_overflow');
    expect(validatePlanDraft(draft([action({ action_kind: 'limited_discount' })]), { prefs }).map((e) => e.code)).toContain('discount_not_allowed');
    expect(validatePlanDraft(draft([action({ operational: { ...action().operational, capacity: { status: 'blocked', max_additional: 0, note: { ar: '', en: '' } } } })]), { prefs }).map((e) => e.code)).toContain('full_slot_promotion');
    expect(validatePlanDraft(draft([action()]), { prefs })).toEqual([]);
  });
});
