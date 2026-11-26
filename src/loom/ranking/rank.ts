import type { EvidenceStrength } from '../contracts/opportunity';
import type { GoalKind, ResolvedProfile } from '../profile/facts';
import { RANKING_FACTORS, type RankingFactor, type RankingWeights } from '../settings/platform';
import { L, type Localized } from '../util/text';

/**
 * Explained ranking (§6.8): score = Σ wᵢ·fᵢ with every fᵢ ∈ [0, 1] defined by
 * a published rule. Each card shows the two factors that raised it most and
 * the one that lowered it most. There is no numeric "confidence": evidence
 * strength is a category with reasons.
 */
export const FACTOR_LABEL: Record<RankingFactor, Localized> = {
  goal_fit: L('توافق الهدف', 'goal fit'), evidence: L('قوة الدليل', 'evidence strength'), impact: L('الأثر المحتمل', 'potential impact'),
  feasibility: L('قابلية التنفيذ', 'feasibility'), cost_effort: L('التكلفة والجهد', 'cost and effort'), timing: L('التوقيت', 'timing'), risk: L('المخاطر والتعارض', 'risk and conflicts'),
};

export const STRENGTH_VALUE: Record<EvidenceStrength, number> = { strong: 1, moderate: 0.66, limited: 0.33, insufficient: 0 };

export type RankInput = {
  key: string;
  goal_kinds: GoalKind[];
  offering_ids: string[];
  evidence_strength: EvidenceStrength;
  /** Conservative incremental contribution (minor); null when costs are unknown. */
  impact_minor: number | null;
  capacity: 'ok' | 'constrained' | 'blocked' | 'unknown' | 'not_needed';
  inventory: 'ok' | 'constrained' | 'reorder_needed' | 'no_recipe' | 'not_applicable';
  prerequisites: number;
  effort_hours: number;
  cash_cost: 'none' | 'variable';
  /** 1 = window within 14 days or a documented linked event; 0.5 = ongoing. */
  timing: number;
  conflict: boolean;
  quality_risk: boolean;
  blocked: boolean;
};

export type Ranked<T> = T & { rank: number; score: number; factors: Record<RankingFactor, number>; explanation: Localized; bucket: 'top' | 'study' | 'blocked' };

export function goalFit(profile: Pick<ResolvedProfile, 'goals' | 'prefs'>, kinds: GoalKind[], offeringIds: string[]): number {
  let f = 0;
  for (const g of profile.goals) {
    if (!kinds.includes(g.kind)) continue;
    if (g.offering_ids.length && !g.offering_ids.some((id) => offeringIds.includes(id))) continue;
    f = Math.max(f, g.priority === 'primary' ? 1 : 0.5);
  }
  if (offeringIds.some((id) => profile.prefs.growth_offerings.includes(id))) f = Math.max(f, 0.5);
  return f;
}

export function factorsOf(r: RankInput, maxImpact: number, profile: Pick<ResolvedProfile, 'goals' | 'prefs'>): Record<RankingFactor, number> {
  const cap = r.capacity === 'ok' || r.capacity === 'not_needed' ? 1 : r.capacity === 'constrained' ? 0.5 : 0;
  const inv = r.inventory === 'ok' || r.inventory === 'not_applicable' ? 1 : r.inventory === 'constrained' || r.inventory === 'no_recipe' ? 0.5 : 0;
  return {
    goal_fit: goalFit(profile, r.goal_kinds, r.offering_ids),
    evidence: STRENGTH_VALUE[r.evidence_strength],
    impact: r.impact_minor !== null && maxImpact > 0 ? Math.max(0, Math.min(1, r.impact_minor / maxImpact)) : 0,
    feasibility: (cap + inv + (r.prerequisites ? 0 : 1)) / 3,
    cost_effort: Math.max(0, 1 - Math.min(1, r.effort_hours / 8) * 0.6 - (r.cash_cost === 'variable' ? 0.4 : 0)),
    timing: r.timing,
    risk: Math.max(0, 1 - (r.conflict ? 0.5 : 0) - (r.quality_risk ? 0.3 : 0)),
  };
}

export function explain(factors: Record<RankingFactor, number>, w: RankingWeights): Localized {
  const contrib = RANKING_FACTORS.filter((f) => w[f] > 0).map((f) => ({ f, c: w[f] * factors[f], v: factors[f] }));
  const up = [...contrib].sort((a, b) => b.c - a.c || a.f.localeCompare(b.f)).slice(0, 2).map((x) => FACTOR_LABEL[x.f]);
  const down = [...contrib].sort((a, b) => a.v - b.v || w[b.f] - w[a.f])[0];
  const d = down ? FACTOR_LABEL[down.f] : L('—', '—');
  return L(`رفعها: ${up.map((x) => x.ar).join(' و')}؛ وخفّضها: ${d.ar}.`, `Raised by ${up.map((x) => x.en).join(' and ')}; lowered by ${d.en}.`);
}

/** Ranks candidates; up to `topN` unblocked ones go to the main page ("top"), the rest to "study". */
export function rank<T extends RankInput>(items: T[], weights: RankingWeights, profile: Pick<ResolvedProfile, 'goals' | 'prefs'>, topN = 5): Array<Ranked<T>> {
  const maxImpact = Math.max(0, ...items.map((i) => i.impact_minor ?? 0));
  const scored = items.map((i) => {
    const factors = factorsOf(i, maxImpact, profile);
    const score = Math.round(RANKING_FACTORS.reduce((m, f) => m + weights[f] * factors[f], 0) * 10_000) / 10_000;
    return { ...i, factors, score, explanation: explain(factors, weights) };
  }).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  let top = 0;
  return scored.map((s, idx) => {
    const bucket: 'top' | 'study' | 'blocked' = s.blocked ? 'blocked' : top < topN ? 'top' : 'study';
    if (bucket === 'top') top++;
    return { ...s, rank: idx + 1, bucket };
  });
}

/** Categorical evidence strength from sample, data quality and cost completeness (never a number shown to users). */
export function evidenceStrength(o: { n: number; min: number; domainOk: boolean; costsNeeded: boolean; costsComplete: boolean; exploratory: boolean }): { strength: EvidenceStrength; reasons: Localized[] } {
  const reasons: Localized[] = [];
  let s: EvidenceStrength = o.n <= 0 ? 'insufficient' : o.n >= 2 * o.min && o.domainOk ? 'strong' : o.n >= o.min ? 'moderate' : 'limited';
  reasons.push(L(`حجم العينة ${o.n} (الحد الأدنى ${o.min})`, `Sample size ${o.n} (minimum ${o.min})`));
  if (!o.domainOk) reasons.push(L('جودة البيانات في هذا المجال محدودة', 'Data quality in this area is limited'));
  if (o.costsNeeded && !o.costsComplete) { if (s === 'strong') s = 'moderate'; reasons.push(L('التكاليف غير مكتملة', 'Costs are incomplete')); }
  if (o.exploratory && (s === 'strong' || s === 'moderate')) { s = 'limited'; reasons.push(L('تحليل استكشافي لنشاط جديد', 'Exploratory analysis for a new business')); }
  return { strength: s, reasons };
}
