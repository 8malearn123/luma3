import type { CanonicalDataset, CostFact, Offering, Transaction, TransactionLine } from '../contracts/canonical';

/**
 * Unit economics (§7.1): m = p − v, where v = material + staff commission +
 * payment fee + platform fee (marketplace share). Pure functions.
 */
export type UnitEconomics = {
  offering_id: string;
  /** Unit net price: realised average over the window's sales, else the list price. */
  price_minor: number; price_basis: 'realized' | 'list';
  material_minor: number | null; material_basis: CostFact['basis'] | null;
  commission_minor: number; commission_rate_bp: number;
  platform_fee_minor: number;
  payment_fee: 'not_tracked' | 'included';
  variable_minor: number | null;
  margin_minor: number | null;
  margin_ratio: number | null;
  /** Share of the window's sales whose direct cost is known (1 when no sales and the cost is known). */
  completeness: number;
  sales_n: number;
};

export type SaleLine = { line: TransactionLine; tx: Transaction };

export function commissionRateFor(ds: Pick<CanonicalDataset, 'costs'>, kind: Offering['kind']): number {
  const cat = kind === 'product' ? 'products' : 'services';
  const f = ds.costs.find((c) => c.type === 'commission' && c.scope.kind === 'category' && c.scope.category === cat);
  return f?.rate_bp ?? 0;
}

export function materialFact(ds: Pick<CanonicalDataset, 'costs'>, offeringId: string) {
  return ds.costs.find((c) => c.type === 'material' && c.scope.kind === 'offering' && c.scope.offering_id === offeringId) ?? null;
}

export function unitEconomics(ds: Pick<CanonicalDataset, 'costs'>, o: Offering, sales: SaleLine[]): UnitEconomics {
  const qty = sales.reduce((m, s) => m + s.line.qty, 0);
  const net = sales.reduce((m, s) => m + s.line.net_minor, 0);
  const price = qty > 0 ? Math.round(net / qty) : o.price_minor;
  const mat = materialFact(ds, o.id);
  const materialKnown = mat && mat.completeness === 'complete' && mat.amount_minor !== null;
  const material = materialKnown ? mat!.amount_minor! : null;
  const rate = commissionRateFor(ds, o.kind);
  const commission = Math.round((price * rate) / 10_000);
  // Platform fee allocated to lines pro rata to their net share of the transaction.
  let fee = 0;
  for (const s of sales) if (s.tx.platform_fee_minor > 0 && s.tx.net_minor > 0) fee += (s.tx.platform_fee_minor * s.line.net_minor) / s.tx.net_minor;
  const platformFee = qty > 0 ? Math.round(fee / qty) : 0;
  // Completeness: a sale has known direct cost when the line carries it or the offering's material cost is known.
  const known = sales.filter((s) => s.line.cost_direct_minor !== null || materialKnown).length;
  const completeness = sales.length ? known / sales.length : materialKnown ? 1 : 0;
  const variable = material === null ? null : material + commission + platformFee;
  const margin = variable === null ? null : price - variable;
  return {
    offering_id: o.id, price_minor: price, price_basis: qty > 0 ? 'realized' : 'list',
    material_minor: material, material_basis: mat?.basis ?? null, commission_minor: commission, commission_rate_bp: rate,
    platform_fee_minor: platformFee, payment_fee: 'not_tracked', variable_minor: variable, margin_minor: margin,
    margin_ratio: margin === null || price <= 0 ? null : margin / price, completeness, sales_n: sales.length,
  };
}

/** §7.2 discount break-even. m₁ ≤ 0 ⇒ the discount is rejected. */
export function breakEven(i: { price_minor: number; variable_minor: number; discount_bp: number; campaign_cost_minor?: number; baseline_volume?: number }) {
  const p = i.price_minor, v = i.variable_minor, d = i.discount_bp / 10_000, C = i.campaign_cost_minor ?? 0;
  const N0 = i.baseline_volume && i.baseline_volume > 0 ? i.baseline_volume : 1;
  const m0 = p - v;
  const m1 = p * (1 - d) - v;
  if (m1 <= 0) return { m0, m1, required_volume: null, volume_increase: null, rejected: true as const };
  const N1 = (N0 * m0 + C) / m1;
  return { m0, m1, required_volume: N1, volume_increase: N1 / N0 - 1, rejected: false as const };
}

/** §7.3 price increase: break-even volume loss and elasticity scenarios (−0.5, −1, −1.5). Never applied automatically. */
export function priceIncreaseScenarios(i: { price_minor: number; variable_minor: number; increase_bp: number }) {
  const m0 = i.price_minor - i.variable_minor;
  const p1 = i.price_minor * (1 + i.increase_bp / 10_000);
  const m1 = p1 - i.variable_minor;
  const breakevenLoss = m1 > 0 ? 1 - m0 / m1 : null;
  const scenarios = [-0.5, -1, -1.5].map((e) => {
    const volume = 1 + e * (i.increase_bp / 10_000);
    return { elasticity: e, volume_change: volume - 1, margin_change: m0 > 0 ? (volume * m1) / m0 - 1 : null };
  });
  return { m0, m1, breakeven_volume_loss: breakevenLoss, scenarios };
}
