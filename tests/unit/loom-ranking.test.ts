import { describe, expect, it } from 'vitest';
import { DEFAULT_RANKING_WEIGHTS, evidenceStrength, platformSettingsSchema, PLATFORM_DEFAULTS, rank, RANKING_FACTORS } from '@/loom';
import { analyzeDs, matureSalon, profileWith } from '../helpers/loom-dataset';

const item = (key: string, o: Partial<Parameters<typeof rank>[0][number]> = {}) => ({
  key, goal_kinds: [], offering_ids: [], evidence_strength: 'moderate' as const, impact_minor: null, capacity: 'ok' as const, inventory: 'not_applicable' as const,
  prerequisites: 0, effort_hours: 1, cash_cost: 'none' as const, timing: 1, conflict: false, quality_risk: false, blocked: false, ...o,
});

describe('Loom explained ranking (§6.8)', () => {
  it('default weights sum to 1 and are the platform default', () => {
    expect(RANKING_FACTORS.reduce((m, f) => m + DEFAULT_RANKING_WEIGHTS[f], 0)).toBeCloseTo(1, 10);
    expect(PLATFORM_DEFAULTS.default_ranking_weights).toEqual(DEFAULT_RANKING_WEIGHTS);
    expect(platformSettingsSchema.shape.default_ranking_weights.safeParse({ ...DEFAULT_RANKING_WEIGHTS, risk: 0.5 }).success).toBe(false);
  });

  it('score = Σ wᵢ·fᵢ; explanation names the two strongest factors and the weakest', () => {
    const p = profileWith([], [{ id: 'g', kind: 'fill_quiet_times', priority: 'primary', offering_ids: [], note: null }]);
    const r = rank([
      item('a', { goal_kinds: ['fill_quiet_times'], evidence_strength: 'strong', impact_minor: 1000 }),
      item('b', { evidence_strength: 'limited', capacity: 'blocked', blocked: true }),
      item('c', { evidence_strength: 'insufficient', impact_minor: 500, cash_cost: 'variable', effort_hours: 8 }),
    ], DEFAULT_RANKING_WEIGHTS, p);
    expect(r[0]!.key).toBe('a');
    expect(r.find((x) => x.key === 'b')!.score).toBeCloseTo(0.2 * 0.33 + 0.15 * (2 / 3) + 0.1 * 0.925 + 0.1 + 0.05, 3);
    expect(r[0]!.factors).toMatchObject({ goal_fit: 1, evidence: 1, impact: 1, feasibility: 1 });
    expect(r[0]!.score).toBeCloseTo(0.2 + 0.2 + 0.2 + 0.15 + 0.1 * (1 - 0.6 / 8) + 0.1 + 0.05, 4);
    expect(r[0]!.explanation.en).toBe('Raised by evidence strength and goal fit; lowered by cost and effort.');
    expect(r[0]!.explanation.ar).toMatch(/^رفعها: .+؛ وخفّضها: .+\.$/);
    expect(r.find((x) => x.key === 'b')!.bucket).toBe('blocked');
    expect(r[0]!.bucket).toBe('top');
  });

  it('at most five unblocked opportunities reach the main page; the rest are "to study"', () => {
    const r = rank(Array.from({ length: 7 }, (_, i) => item(`k${i}`)), DEFAULT_RANKING_WEIGHTS, profileWith());
    expect(r.filter((x) => x.bucket === 'top')).toHaveLength(5);
    expect(r.filter((x) => x.bucket === 'study')).toHaveLength(2);
  });

  it('evidence strength is categorical with reasons (never a number)', () => {
    expect(evidenceStrength({ n: 40, min: 10, domainOk: true, costsNeeded: false, costsComplete: true, exploratory: false }).strength).toBe('strong');
    expect(evidenceStrength({ n: 12, min: 10, domainOk: true, costsNeeded: false, costsComplete: true, exploratory: false }).strength).toBe('moderate');
    expect(evidenceStrength({ n: 40, min: 10, domainOk: true, costsNeeded: true, costsComplete: false, exploratory: false }).strength).toBe('moderate');
    expect(evidenceStrength({ n: 3, min: 10, domainOk: true, costsNeeded: false, costsComplete: true, exploratory: false }).strength).toBe('limited');
    expect(evidenceStrength({ n: 40, min: 10, domainOk: true, costsNeeded: false, costsComplete: true, exploratory: true }).strength).toBe('limited');
    expect(evidenceStrength({ n: 0, min: 10, domainOk: true, costsNeeded: false, costsComplete: true, exploratory: false }).strength).toBe('insufficient');
  });

  it('business weights (ranking_weights fact) change the order', () => {
    const { b } = matureSalon({ s1Cost: null });
    const ds = b.finalize();
    const def = analyzeDs(ds).opportunities.map((o) => o.category);
    const goalHeavy = profileWith([{ key: 'pref.ranking_weights', value: { mode: 'custom', weights: { goal_fit: 0.5, evidence: 0.1, impact: 0.1, feasibility: 0.1, cost_effort: 0.1, timing: 0.05, risk: 0.05 } } }],
      [{ id: 'g', kind: 'increase_margin', priority: 'primary', offering_ids: [], note: null }]);
    expect(goalHeavy.prefs.weights_source).toBe('business');
    const custom = analyzeDs(ds, goalHeavy).opportunities.map((o) => o.category);
    expect(def[0]).toBe('quiet_capacity');
    expect(custom[0]).toBe('missing_cost_blocker');
  });
});
