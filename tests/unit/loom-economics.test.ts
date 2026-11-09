import { describe, expect, it } from 'vitest';
import { breakEven, priceIncreaseScenarios, unitEconomics, type Offering, type Transaction } from '@/loom';

describe('Loom economics (§7)', () => {
  it('T5: 15% off 200 with variable cost 80 needs +33.3% volume (reference vector)', () => {
    const r = breakEven({ price_minor: 200, variable_minor: 80, discount_bp: 1500 });
    expect(r.m0).toBe(120);
    expect(r.m1).toBeCloseTo(90, 10);
    expect(r.volume_increase).toBeCloseTo(1 / 3, 10);
    expect(Math.abs(r.volume_increase! - 0.333)).toBeLessThanOrEqual(0.001);
    // Independent of the baseline when the campaign has no fixed cost; the fixed cost raises the bar.
    expect(breakEven({ price_minor: 200, variable_minor: 80, discount_bp: 1500, baseline_volume: 37 }).volume_increase).toBeCloseTo(1 / 3, 10);
    expect(breakEven({ price_minor: 200, variable_minor: 80, discount_bp: 1500, baseline_volume: 100, campaign_cost_minor: 900 }).volume_increase).toBeCloseTo((100 * 120 + 900) / 90 / 100 - 1, 10);
  });

  it('rejects a discount when the margin after it is zero or negative', () => {
    expect(breakEven({ price_minor: 200, variable_minor: 170, discount_bp: 1500 })).toMatchObject({ rejected: true, volume_increase: null });
    expect(breakEven({ price_minor: 200, variable_minor: 170, discount_bp: 1500 }).m1).toBeLessThanOrEqual(0);
  });

  it('price increases show elasticity scenarios and the break-even volume loss', () => {
    const r = priceIncreaseScenarios({ price_minor: 200, variable_minor: 80, increase_bp: 1000 });
    expect(r.m1).toBeCloseTo(140, 8);
    expect(r.breakeven_volume_loss).toBeCloseTo(1 - 120 / 140, 10);
    expect(r.scenarios.map((s) => s.elasticity)).toEqual([-0.5, -1, -1.5]);
    expect(r.scenarios[1]!.volume_change).toBeCloseTo(-0.1, 10);
  });

  it('unit margin = p − (material + commission + platform fee); payment fees are not tracked', () => {
    const o: Offering = { id: 's', kind: 'service', source_kind: 'service', name: { ar: 'x', en: 'x' }, price_minor: 20000, status: 'active', category_id: null, duration_min: 60, buffer_min: 0,
      has_image: true, has_description: true, recorded_cost_minor: 3000, visible: true, product_id: null, location_id: null };
    const tx = (net: number, fee: number): Transaction => ({ id: `t${net}${fee}`, kind: 'booking', status: 'fulfilled', source_status: 'completed', channel: fee ? 'marketplace' : 'direct', origin: null, customer_ref: 'c',
      gross_minor: net, discount_minor: 0, tax_minor: 0, total_minor: net, refunded_minor: 0, net_minor: net, occurred_at: 0, campaign_id: null, has_coupon: false, platform_fee_minor: fee,
      lines: [{ id: 'l', offering_id: 's', resource_ids: [], qty: 1, net_minor: net, line_total_minor: net, cost_direct_minor: null, starts_at: 0, duration_min: 60 }], consistent: true });
    const a = tx(20000, 0), b = tx(20000, 2000);
    const ds = { costs: [
      { type: 'material' as const, scope: { kind: 'offering' as const, offering_id: 's' }, amount_minor: 3000, rate_bp: null, basis: 'recorded_cost' as const, completeness: 'complete' as const },
      { type: 'commission' as const, scope: { kind: 'category' as const, category: 'services' as const }, amount_minor: null, rate_bp: 1000, basis: 'policy' as const, completeness: 'complete' as const },
    ] };
    const e = unitEconomics(ds, o, [{ line: a.lines[0]!, tx: a }, { line: b.lines[0]!, tx: b }]);
    expect(e).toMatchObject({ price_minor: 20000, price_basis: 'realized', material_minor: 3000, commission_minor: 2000, platform_fee_minor: 1000, variable_minor: 6000, margin_minor: 14000, completeness: 1, payment_fee: 'not_tracked' });
    const missing = unitEconomics({ costs: ds.costs.slice(1) }, { ...o, recorded_cost_minor: null }, []);
    expect(missing).toMatchObject({ material_minor: null, margin_minor: null, completeness: 0, price_basis: 'list' });
  });
});
