import { describe, expect, it } from 'vitest';
import { translate } from '@/i18n';
import { localizedTaxLabel } from '@/shared/tax-label';

/** LUMA-AUDIT-039: plural rules and mixed-language labels in the English UI. */
describe('plural messages', () => {
  it('English: 1 business / 2 businesses (never "1 businesses")', () => {
    expect(translate('en', 'market.doors.count', { n: 1 })).toBe('1 business');
    expect(translate('en', 'market.doors.count', { n: 2 })).toBe('2 businesses');
    expect(translate('en', 'market.doors.count', { n: 0 })).toBe('No businesses yet');
    expect(translate('en', 'market.results', { n: 1 })).toBe('1 result');
    expect(translate('en', 'market.rating_aria', { avg: 4.8, n: 1 })).toBe('Rated 4.8 out of 5 (1 review)');
  });
  it('Arabic uses CLDR categories (one/two/few/many)', () => {
    expect(translate('ar', 'market.doors.count', { n: 1 })).toBe('نشاط واحد');
    expect(translate('ar', 'market.doors.count', { n: 2 })).toBe('نشاطان');
    expect(translate('ar', 'market.doors.count', { n: 5 })).toBe('5 أنشطة');
    expect(translate('ar', 'market.doors.count', { n: 11 })).toBe('11 نشاطًا');
    expect(translate('ar', 'market.doors.count', { n: 100 })).toBe('100 نشاط');
  });
  it('plain messages are unaffected by n', () => {
    expect(translate('en', 'builder.versions.v', { n: 3 })).toBe('Version 3');
  });
});

describe('tax label', () => {
  it('English UI replaces an Arabic-only label with the localized generic one', () => {
    expect(localizedTaxLabel('ضريبة القيمة المضافة', 'en', 'Tax')).toBe('Tax');
    expect(localizedTaxLabel('ضريبة القيمة المضافة', 'ar', 'الضريبة')).toBe('ضريبة القيمة المضافة');
    expect(localizedTaxLabel('VAT 15%', 'en', 'Tax')).toBe('VAT 15%');
    expect(localizedTaxLabel(null, 'en', 'Tax')).toBe('Tax');
  });
});
