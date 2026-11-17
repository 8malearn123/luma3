/** Inventory unit conversion. Only same-dimension conversions are allowed; anything else is a mismatch (§5.4). */
const FACTORS: Record<string, { dim: string; f: number }> = {
  piece: { dim: 'count', f: 1 }, ml: { dim: 'volume', f: 1 }, l: { dim: 'volume', f: 1000 }, g: { dim: 'mass', f: 1 }, kg: { dim: 'mass', f: 1000 },
};

/** Converts `qty` from `from` to `to`; null when the units are not convertible. */
export function convertQty(qty: number, from: string, to: string): number | null {
  if (from === to) return qty;
  const a = FACTORS[from], b = FACTORS[to];
  if (!a || !b || a.dim !== b.dim) return null;
  return (qty * a.f) / b.f;
}
