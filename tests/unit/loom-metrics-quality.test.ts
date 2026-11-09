import { describe, expect, it } from 'vitest';
import { computeMetrics, defineMetric, metricDefinitions, MetricContext, qualityGate } from '@/loom';
import { definitionRecord as definitionRecordOf } from '@/loom/metrics/registry';
import { datasetBuilder, matureSalon } from '../helpers/loom-dataset';

describe('Loom metrics registry (§6.3)', () => {
  it('defines the v1 set once, bilingual, versioned, with a formula, window and minimum sample', () => {
    const defs = metricDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(35);
    expect(new Set(defs.map((d) => d.key)).size).toBe(defs.length);
    for (const d of defs) {
      expect(d.label.ar.length).toBeGreaterThan(0);
      expect(d.label.en.length).toBeGreaterThan(0);
      expect(d.version).toBeGreaterThanOrEqual(1);
      expect(d.formula.length).toBeGreaterThan(5);
      expect(d.window.length).toBeGreaterThan(0);
      expect(d.min_sample).toBeGreaterThanOrEqual(0);
    }
    const domains = new Set(defs.map((d) => d.domain));
    for (const x of ['sales', 'customers', 'capacity', 'economics', 'inventory', 'demand', 'reviews', 'campaigns']) expect(domains.has(x as never)).toBe(true);
    for (const k of ['sales.completed_net', 'sales.avg_order_value', 'customers.repeat_rate', 'customers.cadence_days', 'customers.lapsed', 'customers.acquisition_mix', 'quality.cancel_customer_rate',
      'quality.no_show_rate', 'quality.rating_avg', 'capacity.occupancy', 'capacity.free_minutes_next14', 'capacity.quiet_slots', 'capacity.full_slots', 'demand.no_availability_30d', 'demand.waitlist_30d',
      'econ.unit_contribution_margin', 'econ.total_contribution_margin', 'econ.discount_share', 'econ.commission_total', 'econ.payment_fees', 'econ.platform_fees', 'econ.cost_completeness',
      'inventory.days_of_cover', 'inventory.slow_movers', 'conversion.start_to_confirm_30d', 'conversion.visit_by_source', 'campaign.attributed_net', 'campaign.incremental_rate']) {
      expect(defs.some((d) => d.key === k)).toBe(true);
    }
  });

  it('refuses a second definition of the same key with another version', () => {
    const d = metricDefinitions().find((x) => x.key === 'sales.completed_net')!;
    expect(() => defineMetric({ ...d, version: d.version + 1 })).toThrow(/defined twice/);
    expect(definitionRecordOf(d).definition_hash).toHaveLength(32);
  });

  it('computes values from the canonical dataset and withholds values below the minimum sample', () => {
    const { b, s1 } = matureSalon();
    const ds = b.finalize();
    const ctx = new MetricContext(ds, { cost_completeness_threshold: 0.8 });
    const m = computeMetrics(ctx);
    expect(m.value('sales.completed_count')).toBe(25);
    expect(m.value('sales.completed_net')).toBe(25 * 20000);
    expect(m.value('sales.completed_count', `offering:${s1.id}`)).toBe(25);
    expect(m.value('econ.unit_contribution_margin', `offering:${s1.id}`)).toBe(16000);
    expect(m.value('econ.cost_completeness')).toBe(1);
    expect(m.get('customers.repeat_rate')).toMatchObject({ status: 'insufficient_sample', value: null, n: 8 });
    expect(m.get('econ.payment_fees')).toMatchObject({ status: 'missing_input', value: null });
    expect(m.value('capacity.free_minutes_next14')).toBe(14 * 8 * 60);
    expect(m.all('capacity.occupancy').length).toBeGreaterThan(1);
  });
});

describe('Loom data-quality gate (§5.4)', () => {
  it('reports a level per domain and bilingual "what improves it"', () => {
    const b = datasetBuilder();
    const s = b.service({ name: 'Cut', cost: null });
    b.staff({ qualified: [s.id] });
    const c = b.customer();
    for (let i = 0; i < 5; i++) b.sale({ offering: s, customer: c, daysAgo: 2 + i });
    const q = qualityGate(new MetricContext(b.finalize(), { cost_completeness_threshold: 0.8 }));
    expect(q.domains.economics.level).toBe('insufficient');
    expect(q.domains.economics.improve[0]!.ar).toMatch(/سجّلي تكلفة 1/);
    expect(q.domains.economics.improve[0]!.en).toMatch(/Record the cost of 1/);
    expect(q.domains.capacity.level).toBe('ok');
    expect(q.domains.sales.level).toBe('limited');
    expect(q.domains.inventory.level).toBe('insufficient');
    expect(q.exploratory).toBe(true);
    expect(q.checks.every((x) => x.detail.ar && x.detail.en)).toBe(true);
  });

  it('applies the configurable cost-completeness threshold', () => {
    const { b, s1 } = matureSalon();
    const s2 = b.service({ name: 'B', cost: null });
    for (let i = 0; i < 2; i++) b.sale({ offering: s2, customer: b.customer(), daysAgo: 5 + i });
    const ds = b.finalize();
    // 25 × 20000 known vs 2 × 20000 unknown ⇒ 92.6% complete.
    const at80 = new MetricContext(ds, { cost_completeness_threshold: 0.8 });
    const at95 = new MetricContext(ds, { cost_completeness_threshold: 0.95 });
    expect(at80.businessCostCompleteness.value).toBeCloseTo(25 / 27, 6);
    expect(qualityGate(at80).checks.find((c) => c.id === 'cost_completeness')!.level).toBe('limited');
    expect(qualityGate(at95).checks.find((c) => c.id === 'cost_completeness')!.level).toBe('limited');
    expect(at80.economics(s1.id)!.completeness).toBe(1);
  });

  it('excludes inconsistent transactions and counts them', () => {
    const { b } = matureSalon();
    b.ds.transactions[0]!.consistent = false;
    const ctx = new MetricContext(b.finalize(), { cost_completeness_threshold: 0.8 });
    expect(ctx.sales90.length).toBe(24);
    expect(qualityGate(ctx).excluded_inconsistent).toBe(1);
  });
});
