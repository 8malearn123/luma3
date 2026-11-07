import { describe, expect, it } from 'vitest';
import { decodeZatca, zatcaAmount, zatcaBase64, zatcaTimestamp, zatcaTlv } from '@/server/domains/finance/zatca';
import { encodeQr } from '@/shared/qr';
import { invoiceHtml } from '@/server/domains/finance/documents';

// Published phase-1 example (ZATCA QR code guideline / community SDKs).
const VECTOR = {
  sellerName: 'Bobs Records', vatNumber: '310122393500003', timestamp: '2022-04-25T15:30:00Z', totalWithVat: '1000.00', vatTotal: '150.00',
};
const VECTOR_B64 = 'AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==';

describe('ZATCA phase 1 TLV', () => {
  it('encodes the published example vector exactly', () => {
    expect(zatcaBase64(VECTOR)).toBe(VECTOR_B64);
  });

  it('uses UTF-8 byte lengths (Arabic seller names) and round-trips', () => {
    const name = 'صالون نور';
    const tlv = zatcaTlv({ ...VECTOR, sellerName: name });
    expect(tlv[0]).toBe(1);
    expect(tlv[1]).toBe(Buffer.byteLength(name, 'utf8'));
    expect(tlv[1]).toBe(17);
    const back = decodeZatca(tlv.toString('base64'));
    expect(back).toEqual({ 1: name, 2: VECTOR.vatNumber, 3: VECTOR.timestamp, 4: '1000.00', 5: '150.00' });
  });

  it('formats amounts and timestamps', () => {
    expect(zatcaAmount(115000)).toBe('1150.00');
    expect(zatcaAmount(5)).toBe('0.05');
    expect(zatcaAmount(-1999)).toBe('-19.99');
    expect(zatcaTimestamp(new Date('2026-11-07T09:05:03.123Z'))).toBe('2026-11-07T09:05:03Z');
  });

  it('bounds a field to 255 bytes without splitting characters', () => {
    const tlv = zatcaTlv({ ...VECTOR, sellerName: 'ن'.repeat(200) });
    expect(tlv[1]).toBe(254);
    expect(decodeZatca(tlv.toString('base64'))[1]).toBe('ن'.repeat(127));
  });
});

describe('QR encoder', () => {
  it('picks the smallest version and draws finder patterns', () => {
    const m = encodeQr(VECTOR_B64, { ecc: 'M' });
    expect(m.size).toBe(m.version * 4 + 17);
    expect(m.version).toBe(6); // 96 bytes at M
    const finderRow = m.modules[0]!.slice(0, 7);
    expect(finderRow).toEqual([true, true, true, true, true, true, true]);
    expect(m.modules[1]!.slice(0, 7)).toEqual([true, false, false, false, false, false, true]);
    expect(m.modules[7]![7]).toBe(false); // separator
    expect(encodeQr('hi', { ecc: 'H' }).version).toBe(1);
  });

  it('is deterministic for a forced mask and rejects oversized data', () => {
    expect(encodeQr('https://luma.sa/s/x', { mask: 2 }).modules).toEqual(encodeQr('https://luma.sa/s/x', { mask: 2 }).modules);
    expect(() => encodeQr('x'.repeat(3000), { ecc: 'H' })).toThrow('qr_data_too_long');
  });
});

describe('invoice HTML', () => {
  const base = {
    id: 'i', number: 'INV-1', kind: 'invoice', currency: 'SAR', issued_at: new Date('2026-11-01T10:00:00Z'), subtotal_minor: 100000, discount_minor: 0, tax_minor: 15000, total_minor: 115000,
    buyer_snapshot: { name: 'نورة' }, items: [{ description: 'قص', quantity: 1, line_total_minor: 100000 }], tenant: { slug: 's', timezone: 'Asia/Riyadh' },
  };
  it('is a simplified tax invoice with a QR when a VAT number is configured', () => {
    const html = invoiceHtml({ ...base, seller_snapshot: { name: 'صالون', legal_name: 'مؤسسة صالون', tax_number: '310122393500003' } } as never, 'ar');
    expect(html).toContain('فاتورة ضريبية مبسطة');
    expect(html).toContain('data-zatca-qr');
    expect(html).toContain('<svg');
    expect(html).toContain('المرحلة الأولى');
    expect(html).toContain('لا يُدّعى الامتثال للمرحلة الثانية');
  });
  it('has no QR and says so without a VAT number', () => {
    const html = invoiceHtml({ ...base, seller_snapshot: { name: 'صالون', tax_number: null } } as never, 'en');
    expect(html).not.toContain('data-zatca-qr');
    expect(html).not.toContain('Simplified tax invoice</h1>');
    expect(html).toContain('without a VAT number');
  });
});
