import { describe, expect, it } from 'vitest';
import { applyEdits, eventThreshold, measureInitiative, MetricContext, windowOccupancy, type CampaignGroups, type CardContent, type MeasureInput } from '@/loom';
import { reviseContent } from '@/server/loom-host/plan-revisions';
import { addDays } from '@/loom/util/time';
import { datasetBuilder, TODAY } from '../helpers/loom-dataset';

const g = (members: number, converters: number, net = converters * 20000) => ({ members, converters, bookings: converters, net_minor: net, cancelled: 0, refunded_minor: 0 });

function salon() {
  const b = datasetBuilder();
  const s1 = b.service({ name: 'Hair', price_minor: 20000, cost: 4000 });
  const s2 = b.service({ name: 'Facial', price_minor: 30000, cost: 6000 });
  const a = b.staff({ qualified: [s1.id, s2.id] });
  const cs = Array.from({ length: 10 }, () => b.customer());
  // Target S2: 2 sales in the pre period (days 21–40 ago), 6 in the window (days 1–20 ago); control S1 steady 5/5.
  for (let i = 0; i < 2; i++) b.sale({ offering: s2, customer: cs[i]!, daysAgo: 25 + i });
  for (let i = 0; i < 6; i++) b.sale({ offering: s2, customer: cs[i]!, daysAgo: 5 + i });
  for (let i = 0; i < 5; i++) { b.sale({ offering: s1, customer: cs[i + 5]!, daysAgo: 30 + i }); b.sale({ offering: s1, customer: cs[i + 5]!, daysAgo: 8 + i }); }
  return { ds: b.finalize(), b, s1, s2, a };
}

const input = (ds: MeasureInput['ds'], offering: string, kind: MeasureInput['initiative']['artifact_kind'], groups: CampaignGroups | null = null, executed = true): MeasureInput => ({
  ds, groups, factors: [],
  initiative: { offering_ids: [offering], window_from: addDays(TODAY, -20), window_to: addDays(TODAY, -1), artifact_kind: kind, artifact_ref: 'camp-1', goal_metrics: ['completed_bookings', 'contribution_margin'], executed, actual_cost_minor: null },
});
const camp = (t: number, h: number, tc: number, hc: number): CampaignGroups => ({ campaign_id: 'camp-1', window_days: 14, started_at: null, target: g(t, tc), holdout: g(h, hc) });

describe('measureInitiative (§10.3)', () => {
  it('incremental only with ≥ 30 per group; otherwise insufficient with attributed kept apart', () => {
    const { ds, s2 } = salon();
    const small = measureInitiative(input(ds, s2.id, 'campaign_draft', camp(40, 29, 10, 3)));
    expect(small.quality).toBe('insufficient');
    expect(small.causal).toBe(false);
    expect(small.incremental).toEqual({ status: 'insufficient_sample', min_group: 30, members: { target: 40, holdout: 29 } });
    expect(small.attributed).toMatchObject({ members: 40, converters: 10, net_minor: 200000 });
    const ok = measureInitiative(input(ds, s2.id, 'campaign_draft', camp(30, 30, 9, 3)));
    expect(ok.quality).toBe('experimental');
    expect(ok.causal).toBe(true);
    expect(ok.incremental).toMatchObject({ status: 'estimated', conversion_rate_lift: 0.2, net_minor: 120000 });
  });

  it('a contaminating external factor downgrades a sized holdout to quasi; a campaign never sent is insufficient', () => {
    const { ds, s2 } = salon();
    const i = input(ds, s2.id, 'campaign_draft', camp(30, 30, 9, 3));
    i.factors = [{ type: 'stockout', ref: 'sig', at: TODAY, label: { ar: 'نفاد', en: 'stockout' }, contaminates: true }];
    expect(measureInitiative(i).quality).toBe('quasi');
    expect(measureInitiative(input(ds, s2.id, 'campaign_draft', null)).quality).toBe('insufficient');
  });

  it('non-partitionable ⇒ observational, never causal, with the control offerings and a difference-in-differences estimate', () => {
    const { ds, s2 } = salon();
    const o = measureInitiative(input(ds, s2.id, 'plan_action'));
    expect(o.design).toBe('pre_post_with_control');
    expect(o.quality).toBe('observational');
    expect(o.causal).toBe(false);
    expect(o.limitations.map((l) => l.ar)).toContain('إشارة محدودة لا علاقة سببية');
    const cb = o.primary.find((m) => m.key === 'completed_bookings')!;
    expect(cb.target).toEqual({ pre: 2, post: 6 });
    expect(cb.control).toEqual({ pre: 5, post: 5 });
    expect(cb.estimate).toBe(4);
    const margin = o.primary.find((m) => m.key === 'contribution_margin')!;
    expect(margin.target.post).toBe(6 * (30000 - 6000));
    // Not executed ⇒ insufficient whatever the data says.
    expect(measureInitiative(input(ds, s2.id, 'plan_action', null, false)).quality).toBe('insufficient');
  });

  it('guardrails flag cancellations in the window', () => {
    const { b, s2 } = salon();
    const c = b.customer();
    for (let i = 0; i < 4; i++) b.sale({ offering: s2, customer: c, daysAgo: 3 + i, status: 'cancelled_customer' });
    const o = measureInitiative(input(b.finalize(), s2.id, 'plan_action'));
    expect(o.guardrails.find((x) => x.key === 'cancellations')!.breached).toBe(true);
    expect(o.learnings.some((l) => /حاجز أمان/.test(l.ar))).toBe(true);
  });
});

describe('Change thresholds (§13)', () => {
  it('inventory: at or under the reorder level (or out); margin: a shift above 10%', () => {
    expect(eventThreshold({ type: 'inventory', scope: 'item:x', data: { available: 51, reorder_level: 50 } })!.pass).toBe(false);
    expect(eventThreshold({ type: 'inventory', scope: 'item:x', data: { available: 50, reorder_level: 50 } })!.pass).toBe(true);
    expect(eventThreshold({ type: 'inventory', scope: 'item:x', data: { available: 0, reorder_level: null } })!.pass).toBe(true);
    const m = (pa: number, ca: number) => eventThreshold({ type: 'margin', scope: 'offering:x', data: { price_before: 20000, price_after: pa, cost_before: 4000, cost_after: ca } })!;
    expect(m(21500, 4000)).toMatchObject({ pass: false, magnitude: 0.0938 });
    expect(m(20000, 6000)).toMatchObject({ pass: true, magnitude: 0.125 });
    expect(eventThreshold({ type: 'capacity', scope: 'staff:x', data: { from: '', to: '' } })).toBeNull();
  });

  it('window occupancy is booked ÷ (free + booked) of qualified staff in the window', () => {
    const b = datasetBuilder();
    const s = b.service({ name: 'S', price_minor: 10000, cost: 1000 });
    const a = b.staff({ qualified: [s.id], hours: ['10:00', '12:00'] });
    const c = b.customer();
    b.book({ offering: s, staff: a, customer: c, inDays: 2, hour: 10, minutes: 120 });
    const ctx = new MetricContext(b.finalize(), { cost_completeness_threshold: 0.8 });
    expect(windowOccupancy(ctx, s.id, { from: addDays(TODAY, 2), to: addDays(TODAY, 2) })).toBe(1);
    expect(windowOccupancy(ctx, s.id, { from: addDays(TODAY, 3), to: addDays(TODAY, 3) })).toBe(0);
  });
});

describe('Initiative edits and plan revisions', () => {
  it('applyEdits returns the approved card and a diff; the original is untouched', () => {
    const card = { title: { ar: 'ع', en: 't' }, channel: ['in_app'], period: { from: '2026-11-01', to: '2026-11-30' }, recommended_action: { kind: 'content', description: { ar: 'أ', en: 'a' }, intervention_id: 'x' } } as unknown as CardContent;
    const { approved, diff } = applyEdits(card, { description: 'جديد', period: { from: '2026-11-05', to: '2026-11-20' } });
    expect(diff.map((d) => d.path)).toEqual(['recommended_action.description', 'period']);
    expect(approved.period.from).toBe('2026-11-05');
    expect(card.period.from).toBe('2026-11-01');
    expect(applyEdits(card, null)).toEqual({ approved: card, diff: [] });
  });

  it('reviseContent annotates the matching plan items and records the reason (the input is not mutated)', () => {
    const content = {
      goal: 'g', baseline: [], initiatives: [{ id: 'loom_1', title: 'Glow', description: '', evidence_refs: ['ev_aaaaaaaaaa'] }],
      activities: [{ id: 'la_1', title: 'Glow', initiative_id: 'loom_1', date_from: null, date_to: null, channel: null, content_idea: null, owner: null, capacity_note: null, monthly_goal_ref: null, status: 'planned' as const },
        { id: 'la_2', title: 'Other', initiative_id: null, date_from: null, date_to: null, channel: null, content_idea: null, owner: null, capacity_note: null, monthly_goal_ref: null, status: 'planned' as const }],
      dates: { start: '2026-11-01', end: '2026-11-30' }, owner: '', budget: { amount_minor: null, status: 'unknown' as const, assumptions: '' }, metrics: [], monthly_goals: [], experimental: false, limitations: '',
    };
    const next = reviseContent(content, { code: 'inventory', text: { ar: 'نفاد مادة', en: 'stockout' }, signal_id: 's' }, [{
      opportunity_id: 'o', initiative_id: 'i', check: 'inventory', status: 'reorder_needed', action: 'restock_first', title: { ar: 'توهج', en: 'Glow x' }, evidence_refs: ['ev_aaaaaaaaaa'], note: { ar: 'يكفي ٢', en: 'covers 2' },
    }]);
    expect(next.activities[0]!.capacity_note).toMatch(/^\[لووم\] نفاد مادة: إعادة الطلب قبل الترويج/);
    expect(next.activities[1]!.capacity_note).toBeNull();
    expect(next.limitations).toMatch(/نفاد مادة \/ stockout/);
    expect(content.activities[0]!.capacity_note).toBeNull();
  });
});
