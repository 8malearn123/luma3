import { describe, expect, it } from 'vitest';
import { splitLines } from '@/server/domains/hosting/money';
import { quote, taxOf } from '@/shared/schemas/hosting';

/**
 * LUMA-AUDIT-037 — hosting money basis. Approved basis (code + docs):
 *  - prices are fixed (D2) and, for the demo salon, tax-inclusive (tenant_settings.prices_include_tax);
 *  - tax is computed ONCE on the booking base (rent + add-ons − add-ons discount) and rounded
 *    half-up to the halala (Math.round), as for bookings;
 *  - the add-ons discount (D5b) applies to add-ons only, never to the rent.
 */
const line = (kind: string, amount: number, tax_included = false) => ({ kind, status: 'approved', amount_minor: amount, tax_included });
const VAT = { rate_bp: 1500, prices_include_tax: true };

describe('hosting tax split (tax-inclusive)', () => {
  it('splits the booking tax by what each stream charges after the add-ons discount', () => {
    // 2 h × SAR 50 rent, one store product SAR 20, 10% add-ons discount, 15% VAT included.
    const q = quote({ price_model: 'fixed_hour', price_minor: 5000, period_min: null, addons_discount_bp: 1000 }, 120,
      [{ addon_id: 'p', kind: 'product', name: 'p', quantity: 1, unit_price_minor: 2000, rental_unit: null }], VAT);
    expect(q).toMatchObject({ rent_minor: 10000, addons_minor: 2000, discount_minor: 200, total_minor: 11800, tax_minor: taxOf(11800, VAT).tax });
    const s = splitLines(q.lines.map((l) => line(l.kind, l.amount_minor, !!l.tax_included)));
    // Rent alone carries 10000 × 15/115 = 1304.35 → 1304; its net is 8696 (the audit observed 8713/8718).
    expect(s.hostingNet).toBe(8696);
    expect(s.productNet).toBe(2000 - Math.round((1539 * 1800) / 11800));
    // The journal stays balanced: provider_clearing + discounts = revenue + tax.
    expect(s.total + s.discount).toBe(s.hostingNet + s.productNet + s.tax);
    expect(s.total).toBe(11800);
  });

  it('allocates the discount to equipment and products, never to the rent', () => {
    const lines = [line('rent', 10000), line('equipment', 1000), line('product', 1000), line('discount', -400)];
    const tax = taxOf(11600, VAT).tax;
    const s = splitLines([...lines, line('tax', tax, true)]);
    // product base 800, hosting base 10000 + 800 = 10800.
    expect(s.productNet).toBe(1000 - Math.round((tax * 800) / 11600));
    expect(s.hostingNet + s.productNet + s.tax).toBe(12000);
  });

  it('leaves tax-exclusive prices unchanged and adds the tax to the total', () => {
    const s = splitLines([line('rent', 10000), line('tax', 1500, false)]);
    expect(s).toMatchObject({ hostingNet: 10000, productNet: 0, tax: 1500, total: 11500 });
  });
});
