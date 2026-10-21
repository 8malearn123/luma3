import { common } from './messages/common';
import { errors } from './messages/errors';
import { auth } from './messages/auth';
import { dashboard } from './messages/dashboard';
import { onboarding } from './messages/onboarding';
import { marketingSite } from './messages/marketing_site';
import { policy } from './messages/policy';

/**
 * Translation dictionary. Arabic is the primary language; English mirrors it.
 * Each domain owns one file in ./messages exporting { ar, en } with identical
 * keys (checked by tests/unit/i18n.test.ts).
 */
export const dictionaries = [common, errors, auth, dashboard, onboarding, marketingSite, policy] as const;

export type Locale = 'ar' | 'en';
export const LOCALES: Locale[] = ['ar', 'en'];
export const dir = (l: Locale) => (l === 'ar' ? 'rtl' : 'ltr');

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else flatten(v, key, out);
  }
  return out;
}

const flat: Record<Locale, Record<string, string>> = { ar: {}, en: {} };
for (const d of dictionaries) {
  Object.assign(flat.ar, flatten(d.ar as Tree));
  Object.assign(flat.en, flatten(d.en as Tree));
}

export function messagesFor(locale: Locale) {
  return flat[locale];
}

/** Interpolates {name} placeholders. Missing keys fall back to the other language, then the key. */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let s = flat[locale][key] ?? flat[locale === 'ar' ? 'en' : 'ar'][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export type T = (key: string, vars?: Record<string, string | number>) => string;
export const makeT = (locale: Locale): T => (key, vars) => translate(locale, key, vars);

/** Picks a localized catalog field (name_ar/name_en) with fallback. */
export function pick(locale: Locale, ar?: string | null, en?: string | null) {
  return (locale === 'ar' ? ar || en : en || ar) ?? '';
}
