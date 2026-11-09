import type { CardContent, OpportunityCard } from '../contracts/opportunity';
import { render, type LoomLocale } from '../util/text';

/** Renders the stored bilingual card into the §11.1 contract for one locale. */
export function renderCard(row: { id: string; business_id: string; card: unknown }, locale: LoomLocale): OpportunityCard {
  const c = row.card as CardContent;
  const r = (t: Parameters<typeof render>[0]) => render(t, locale);
  return {
    opportunity_id: row.id,
    business_id: row.business_id,
    category: c.category,
    title: r(c.title),
    period: c.period,
    why_now: r(c.why_now),
    evidence_refs: c.evidence_refs,
    hypotheses: c.hypotheses.map((h) => ({ text: r(h.text), status: 'hypothesis' as const })),
    recommended_action: { kind: c.recommended_action.kind, description: r(c.recommended_action.description) },
    alternatives_considered: c.alternatives_considered.map((a) => ({ kind: a.kind, rejected_because: r(a.rejected_because) })),
    target_segment: { definition: c.target_segment.definition as Record<string, unknown>, size: c.target_segment.size, size_status: c.target_segment.size_status },
    channel: c.channel,
    timing: { window: r(c.timing.window), event_ref: c.timing.event_ref },
    estimated_cost: c.estimated_cost,
    capacity_check: { status: c.capacity_check.status, max_additional: c.capacity_check.max_additional, note: r(c.capacity_check.note) },
    inventory_check: { status: c.inventory_check.status, covers_n: c.inventory_check.covers_n },
    margin_check: {
      status: c.margin_check.status, unit_margin_before_minor: c.margin_check.unit_margin_before_minor,
      unit_margin_after_minor: c.margin_check.unit_margin_after_minor, breakeven_volume_increase: c.margin_check.breakeven_volume_increase,
    },
    prerequisites: c.prerequisites.map(r),
    draft_content: null,
    success_metrics: c.success_metrics,
    measurement_design: c.measurement_design,
    assumptions: c.assumptions.map(r),
    limitations: c.limitations.map(r),
    data_quality: c.data_quality,
    priority: { rank: c.priority.rank, explanation: r(c.priority.explanation), score: c.priority.score, factors: c.priority.factors, evidence_strength: c.priority.evidence_strength, bucket: c.priority.bucket },
    knowledge_refs: c.knowledge_refs,
    review_at: c.review_at,
  };
}

/** Extra, non-contract details the UI shows next to the card (check notes, action details). */
export function cardDetails(row: { card: unknown }, locale: LoomLocale) {
  const c = row.card as CardContent;
  return {
    recommended_action: { intervention_id: c.recommended_action.intervention_id, discount_bp: c.recommended_action.discount_bp ?? null, direction: c.recommended_action.direction ?? null },
    inventory_note: render(c.inventory_check.note ?? null, locale),
    margin_note: render(c.margin_check.note ?? null, locale),
  };
}
