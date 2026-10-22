/**
 * Controlled inventory unit conversions. Only conversions inside one dimension
 * are allowed (volume: ml↔l, mass: g↔kg, count: piece). Anything else is an
 * incompatible-unit error — never a guess.
 */
export const UNITS = ['piece', 'ml', 'l', 'g', 'kg'] as const;
export type Unit = (typeof UNITS)[number];

const DEF: Record<Unit, { dim: 'count' | 'volume' | 'mass'; factor: number }> = {
  piece: { dim: 'count', factor: 1 },
  ml: { dim: 'volume', factor: 1 },
  l: { dim: 'volume', factor: 1000 },
  g: { dim: 'mass', factor: 1 },
  kg: { dim: 'mass', factor: 1000 },
};

export function unitDimension(u: Unit) {
  return DEF[u].dim;
}

export function unitsCompatible(a: Unit, b: Unit) {
  return DEF[a].dim === DEF[b].dim;
}

/** Rounds to the 3 decimal places stored by numeric(14,3). */
export function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

/** Converts a quantity between compatible units; returns null when incompatible. */
export function convertUnits(quantity: number, from: Unit, to: Unit): number | null {
  if (!unitsCompatible(from, to)) return null;
  return round3((quantity * DEF[from].factor) / DEF[to].factor);
}

/** Integer thousandths, for exact comparisons/divisions of numeric(14,3) values. */
export function milli(n: number) {
  return Math.round(n * 1000);
}
