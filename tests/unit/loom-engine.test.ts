import { describe, expect, it } from 'vitest';
import { beautyPack, checkInventory, competitorPriceKey, runEngine, type AssessedOpportunity } from '@/loom';
import { addDays } from '@/loom/util/time';
import { analyzeDs, datasetBuilder, matureSalon, profileWith, TODAY, uid } from '../helpers/loom-dataset';

/**
 * Acceptance tests of §20 on the rules path, against synthetic canonical
 * datasets (pure engine, deterministic). The same behaviours are exercised
 * end to end through the API in tests/integration/loom-*.test.ts.
 */
const byCat = (ops: AssessedOpportunity[], cat: string) => ops.filter((o) => o.category === cat);
const forOffering = (ops: AssessedOpportunity[], id: string) => ops.filter((o) => o.subject.offering_ids.includes(id));

/** S2: few sales but five 5-star reviews → a high-satisfaction / low-demand candidate. */
function withRatedS2(opts: { cost?: number | null; fullyBooked?: boolean } = {}) {
  const m = matureSalon();
  const s2 = m.b.service({ name: 'Glow facial', price_minor: 30000, cost: opts.cost === undefined ? 6000 : opts.cost });
  const staff = opts.fullyBooked ? m.b.staff({ hours: ['10:00', '12:00'], qualified: [s2.id] }) : m.a;
  if (!opts.fullyBooked) m.b.qualify(m.a, s2.id);
  for (let i = 0; i < 3; i++) m.b.sale({ offering: s2, customer: m.customers[i]!, daysAgo: 20 + i * 10, staff });
  for (let i = 0; i < 5; i++) m.b.review(s2.id, 5);
  if (opts.fullyBooked) for (let d = 0; d < 14; d++) m.b.book({ offering: s2, staff, customer: m.customers[0]!, inDays: d, hour: 10, minutes: 120 });
  return { ...m, s2, staff };
}

describe('Loom engine — §20 acceptance (rules path)', () => {
  it('T1: incomplete costs ⇒ margin_check costs_incomplete, no absolute profitability, and a missing_cost_blocker', () => {
    const { b, s2 } = withRatedS2({ cost: null });
    const r = analyzeDs(b.finalize());
    const blocker = byCat(r.opportunities, 'missing_cost_blocker');
    expect(blocker).toHaveLength(1);
    expect(blocker[0]!.subject.offering_ids).toContain(s2.id);
    const onS2 = forOffering(r.opportunities, s2.id).filter((o) => o.category !== 'missing_cost_blocker');
    expect(onS2.length).toBeGreaterThan(0);
    for (const o of onS2) {
      expect(o.card.margin_check.status).toBe('costs_incomplete');
      expect(o.card.margin_check.unit_margin_before_minor).toBeNull();
      expect(o.card.margin_check.breakeven_volume_increase).toBeNull();
      expect(JSON.stringify(o.card)).not.toMatch(/profitable|مربح/i);
    }
  });

  it('T2: an approved recipe with too little stock ⇒ reorder_needed, the exact covers_n and a reorder prerequisite', () => {
    const { b, s2 } = withRatedS2();
    const oil = b.item({ name: 'Facial oil', on_hand: 60, unit: 'ml' });
    b.recipe(s2.id, oil, 40, 'ml');
    const r = analyzeDs(b.finalize());
    const o = forOffering(r.opportunities, s2.id).find((x) => x.detector_id === 'high_satisfaction_low_demand')!;
    expect(o).toBeTruthy();
    expect(o.reserve.volume).toBeGreaterThanOrEqual(2);
    expect(o.card.inventory_check.status).toBe('reorder_needed');
    expect(o.card.inventory_check.covers_n).toBe(1); // floor(60 / 40)
    expect(o.card.prerequisites.some((p) => /Reorder Facial oil/.test(p.en) && /إعادة طلب/.test(p.ar))).toBe(true);
    // Unit conversion: a recipe in litres against stock in ml.
    b.ds.requirements = b.ds.requirements.filter((x) => x.type !== 'material');
    b.recipe(s2.id, oil, 0.025, 'l');
    expect(checkInventory(r.ctx, s2.id, 3)).toMatchObject({ status: 'reorder_needed', covers_n: 2 }); // 60 ml ÷ 25 ml
  });

  it('T3: no consumption recipe ⇒ no_recipe and no invented count', () => {
    const { b, s2 } = withRatedS2();
    const r = analyzeDs(b.finalize());
    const o = forOffering(r.opportunities, s2.id).find((x) => x.detector_id === 'high_satisfaction_low_demand')!;
    expect(o.card.inventory_check).toMatchObject({ status: 'no_recipe', covers_n: null });
    expect(o.card.inventory_check.note!.en).toMatch(/cannot be estimated/);
    // An unapproved recipe is not used either.
    b.recipe(s2.id, b.item({ name: 'x', on_hand: 1000 }), 1, 'ml', false);
    expect(checkInventory(r.ctx, s2.id, 3)).toMatchObject({ status: 'no_recipe', covers_n: null });
  });

  it('T4: full slots ⇒ no promotion with capacity ok; capacity blocked/constrained and an unserved_demand opportunity instead', () => {
    const { b, s2 } = withRatedS2({ fullyBooked: true });
    const r = analyzeDs(b.finalize());
    const onS2 = forOffering(r.opportunities, s2.id);
    expect(onS2.some((o) => o.promotional && o.category !== 'capacity_prerequisite' && o.card.capacity_check.status === 'ok')).toBe(false);
    const unserved = byCat(onS2, 'unserved_demand');
    expect(unserved).toHaveLength(1);
    expect(['blocked', 'constrained']).toContain(unserved[0]!.card.capacity_check.status);
    expect(unserved[0]!.card.recommended_action.kind).toBe('open_slots');
    // The well-rated but full service is shown as a prerequisite, never as a promotion.
    const pre = byCat(onS2, 'capacity_prerequisite');
    expect(pre).toHaveLength(1);
    expect(pre[0]!.card.priority.bucket).toBe('blocked');
    expect(pre[0]!.card.recommended_action.kind).toBe('staffing');
  });

  describe('T6: discounts', () => {
    /** Lapsed customers, no consent, < 20 customers, thin margin (18%): only a discount passes. */
    function lapsedThinMargin() {
      const m = matureSalon({ s1Cost: 16_400 });
      const old = Array.from({ length: 4 }, () => m.b.customer());
      for (const c of old) for (const d of [200, 170, 140]) m.b.sale({ offering: m.s1, customer: c, daysAgo: d, staff: m.a });
      return m;
    }

    it('without preferences a limited discount is the LAST resort and passes break-even', () => {
      const { b } = lapsedThinMargin();
      const r = analyzeDs(b.finalize());
      const lapsed = byCat(r.opportunities, 'lapsed_cohort')[0]!;
      expect(lapsed.card.recommended_action.kind).toBe('limited_discount');
      expect(lapsed.card.alternatives_considered.map((a) => a.intervention_id)).toEqual(['reminder_due', 'loyalty_reward', 'value_add']);
      expect(lapsed.card.margin_check.unit_margin_after_minor).toBeGreaterThan(0);
      expect(lapsed.card.margin_check.breakeven_volume_increase).toBeGreaterThan(0);
    });

    it('no_discounts = true ⇒ no *_discount intervention anywhere (chosen or listed)', () => {
      const { b } = lapsedThinMargin();
      const r = analyzeDs(b.finalize(), profileWith([{ key: 'pref.no_discounts', value: true }]));
      const kinds = r.opportunities.flatMap((o) => [o.card.recommended_action, ...o.card.alternatives_considered]).flatMap((a) => [a.kind, a.intervention_id]);
      expect(kinds.length).toBeGreaterThan(0);
      expect(kinds.filter((k) => /discount/.test(k))).toEqual([]);
      expect(r.suppressed.some((s) => s.detector_id === 'lapsed_cohort' && s.reason === 'no_viable_intervention')).toBe(true);
    });

    it('a discount whose margin after discount is ≤ 0 is rejected', () => {
      const m = matureSalon({ s1Cost: 17_500 }); // ratio 12.5% < 15% discount ⇒ m1 < 0
      const old = Array.from({ length: 4 }, () => m.b.customer());
      for (const c of old) for (const d of [200, 170, 140]) m.b.sale({ offering: m.s1, customer: c, daysAgo: d, staff: m.a });
      const r = analyzeDs(m.b.finalize());
      expect(byCat(r.opportunities, 'lapsed_cohort')).toHaveLength(0);
    });
  });

  it('T8: a documented event alone never creates an opportunity; it only times an internal one', () => {
    const lonely = matureSalon();
    lonely.b.ds.calendar.push({ id: uid('e'), title: 'اليوم الوطني', kind: 'holiday', starts_on: addDays(TODAY, 10), ends_on: addDays(TODAY, 10), verified: true, has_source: true });
    // Fully booked: no internal opportunity at all.
    for (let d = 0; d < 14; d++) lonely.b.book({ offering: lonely.s1, staff: lonely.a, customer: lonely.customers[0]!, inDays: d, hour: 10, minutes: 480 });
    const r1 = analyzeDs(lonely.b.finalize());
    expect(r1.opportunities.filter((o) => o.card.timing.event_ref)).toHaveLength(0);
    expect(r1.opportunities.some((o) => /الوطني/.test(o.card.title.ar))).toBe(false);

    const busy = matureSalon();
    const ev = { id: uid('e'), title: 'اليوم الوطني', kind: 'holiday', starts_on: addDays(TODAY, 10), ends_on: addDays(TODAY, 10), verified: true, has_source: true };
    busy.b.ds.calendar.push(ev);
    const r2 = analyzeDs(busy.b.finalize());
    const quiet = byCat(r2.opportunities, 'quiet_capacity')[0]!;
    expect(quiet.card.timing.event_ref).toBe(`calendar:${ev.id}`);
    expect(r2.opportunities.every((o) => o.detector_id !== 'seasonal_alignment')).toBe(true);
  });

  it('T11: a new business (< 30 days, < 20 sales) gets an exploratory analysis with a data-needed list and no fine segments', () => {
    const b = datasetBuilder({ createdDaysAgo: 12 });
    const s = b.service({ name: 'Cut', price_minor: 15000, cost: 2000 });
    const a = b.staff({ qualified: [s.id] });
    const cs = Array.from({ length: 4 }, () => b.customer({ consents: { in_app: true } }));
    for (let i = 0; i < 6; i++) b.sale({ offering: s, customer: cs[i % 4]!, daysAgo: 1 + i, staff: a });
    const r = analyzeDs(b.finalize());
    expect(r.quality.exploratory).toBe(true);
    expect(r.quality.data_needed.length).toBeGreaterThan(0);
    expect(r.suppressed).toEqual(expect.arrayContaining([
      { detector_id: 'lapsed_cohort', reason: 'exploratory_no_segmentation' },
      { detector_id: 'cross_sell_affinity', reason: 'exploratory_no_segmentation' },
    ]));
    for (const o of r.opportunities) {
      expect(['strong', 'moderate']).not.toContain(o.evidence_strength);
      expect(o.card.measurement_design).not.toBe('holdout');
      if (o.card.target_segment.size_status === 'counted') expect(o.card.target_segment.size).toBeGreaterThanOrEqual(30);
      expect(o.card.limitations.some((l) => /Exploratory/.test(l.en))).toBe(true);
    }
  });

  it('T15: a lower competitor price never yields a price cut; price reviews only come from internal margin evidence', () => {
    const healthy = matureSalon();
    const p = profileWith([{ key: competitorPriceKey(healthy.s1.id), value: 9000 }]);
    expect(p.competitor_prices[healthy.s1.id]).toBe(9000);
    const r1 = analyzeDs(healthy.b.finalize(), p);
    expect(r1.opportunities.some((o) => o.card.recommended_action.kind === 'price_review')).toBe(false);

    const thin = matureSalon({ s1Cost: 18_000 });
    const r2 = analyzeDs(thin.b.finalize(), profileWith([{ key: competitorPriceKey(thin.s1.id), value: 9000 }]));
    const reviews = r2.opportunities.filter((o) => o.card.recommended_action.kind === 'price_review' && o.category === 'margin_leak');
    for (const o of reviews) expect(o.card.recommended_action.direction ?? 'increase_review').toBe('increase_review');
    expect(JSON.stringify(r2.opportunities)).not.toMatch(/decrease|lower the price|خفض السعر/i);
  });

  it('respects excluded offerings: no promotion of an excluded service', () => {
    const { b, s2 } = withRatedS2();
    const r = analyzeDs(b.finalize(), profileWith([{ key: 'pref.excluded_offerings', value: [s2.id] }]));
    expect(forOffering(r.opportunities, s2.id).filter((o) => o.promotional)).toHaveLength(0);
    expect(r.suppressed.some((s) => s.reason === 'excluded_offering')).toBe(true);
  });

  it('capacity deducts volume reserved by approved initiatives first (conflicts)', () => {
    const { b, s2 } = withRatedS2();
    const ds = b.finalize();
    const free = analyzeDs(ds).opportunities.find((o) => o.detector_id === 'high_satisfaction_low_demand')!.checks.capacity.max_additional!;
    const { ctx, metrics, quality } = analyzeDs(ds);
    const r = runEngine({ ds, ctx, metrics, quality, profile: profileWith(), pack: beautyPack, params: {} }, { reserved: new Map([[s2.id, free - 1]]) });
    const o = r.opportunities.find((x) => x.detector_id === 'high_satisfaction_low_demand')!;
    expect(o.checks.capacity.max_additional).toBe(1);
    expect(o.card.capacity_check.status).toBe('constrained');
  });

  it('is deterministic: the same dataset yields the same fingerprints, ranks and cards', () => {
    const { b } = withRatedS2();
    const ds = b.finalize();
    const a = analyzeDs(ds).opportunities.map((o) => [o.fingerprint, o.card.priority.rank, o.card.title.en]);
    const c = analyzeDs(ds).opportunities.map((o) => [o.fingerprint, o.card.priority.rank, o.card.title.en]);
    expect(c).toEqual(a);
    expect(new Set(a.map((x) => x[0])).size).toBe(a.length);
    expect(a.every((x) => String(x[0]).endsWith(TODAY.slice(0, 7)))).toBe(true);
  });

  it('every assessed card carries all §11.1 fields and an explained rank without numeric confidence', () => {
    const { b } = withRatedS2({ cost: null });
    const r = analyzeDs(b.finalize());
    for (const o of r.opportunities) {
      for (const k of ['category', 'title', 'period', 'why_now', 'recommended_action', 'target_segment', 'channel', 'timing', 'estimated_cost', 'capacity_check', 'inventory_check', 'margin_check',
        'prerequisites', 'success_metrics', 'measurement_design', 'assumptions', 'limitations', 'data_quality', 'priority', 'review_at']) expect(o.card).toHaveProperty(k);
      expect(o.evidence.length).toBeGreaterThan(0);
      expect(o.card.priority.explanation.en).toMatch(/^Raised by .+ and .+; lowered by .+\.$/);
      expect(JSON.stringify(o.card)).not.toMatch(/"confidence"/);
      expect(o.card.review_at).toBe(addDays(TODAY, 14));
    }
    expect(r.opportunities.map((o) => o.card.priority.rank)).toEqual(r.opportunities.map((_, i) => i + 1));
    expect(r.opportunities.filter((o) => o.card.priority.bucket === 'top').length).toBeLessThanOrEqual(5);
  });
});
