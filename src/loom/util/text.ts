import { createHash } from 'node:crypto';

/** Bilingual text. Loom stores both languages; the API renders one. */
export type Localized = { ar: string; en: string };
export type LoomLocale = 'ar' | 'en';

export const L = (ar: string, en: string): Localized => ({ ar, en });
export const render = (t: Localized | null | undefined, locale: LoomLocale) => (t ? t[locale] || t.ar || t.en : '');
export const joinL = (parts: Localized[], sep = { ar: '، ', en: ', ' }): Localized => ({ ar: parts.map((p) => p.ar).join(sep.ar), en: parts.map((p) => p.en).join(sep.en) });

/** Order-independent JSON hash (object keys sorted). */
export function stableHash(v: unknown): string {
  const norm = (x: unknown): unknown => (Array.isArray(x) ? x.map(norm)
    : x && typeof x === 'object' && !(x instanceof Date) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x);
  return createHash('sha256').update(JSON.stringify(norm(v))).digest('hex');
}

export const pct = (x: number | null | undefined, digits = 0) => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`);
export const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
