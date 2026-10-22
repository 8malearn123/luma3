import { describe, expect, it } from 'vitest';
import { dictionaries, translate } from '@/i18n';

function keys(tree: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : keys(v as Record<string, unknown>, `${prefix}${k}.`)));
}

describe('i18n dictionaries', () => {
  it('every Arabic key has an English counterpart and vice versa', () => {
    for (const d of dictionaries) {
      const ar = keys(d.ar as Record<string, unknown>).sort();
      const en = keys(d.en as Record<string, unknown>).sort();
      expect(en).toEqual(ar);
    }
  });
  it('interpolates variables', () => {
    expect(translate('en', 'onboarding.step_of', { n: 3 })).toBe('Step 3 of 7');
  });
});
