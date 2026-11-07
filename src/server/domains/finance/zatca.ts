import { encodeQr, qrSvg } from '@/shared/qr';

/**
 * ZATCA simplified tax invoice QR, phase 1 (generation phase): five TLV
 * fields — 1 seller name, 2 VAT registration number, 3 invoice timestamp
 * (ISO 8601), 4 invoice total including VAT, 5 VAT total — each encoded as
 * tag byte + length byte + UTF-8 value, concatenated and Base64-encoded.
 *
 * This is phase 1 only. Phase 2 (integration: cryptographic stamp, XML,
 * clearance/reporting with the Fatoora platform) is NOT implemented and no
 * compliance with it is claimed.
 */
export type ZatcaFields = { sellerName: string; vatNumber: string; timestamp: Date | string; totalWithVat: string; vatTotal: string };

/** Truncates to at most `max` UTF-8 bytes without splitting a character. */
function utf8Bounded(s: string, max = 255): Buffer {
  let buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return buf;
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, 'utf8') > max) break;
    out += ch;
  }
  buf = Buffer.from(out, 'utf8');
  return buf;
}

export function zatcaTimestamp(t: Date | string) {
  if (typeof t === 'string') return t;
  return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Minor units (halalas) → "1150.00". */
export function zatcaAmount(minor: number) {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function zatcaTlv(f: ZatcaFields): Buffer {
  const values = [f.sellerName, f.vatNumber, zatcaTimestamp(f.timestamp), f.totalWithVat, f.vatTotal];
  return Buffer.concat(values.map((v, i) => {
    const bytes = utf8Bounded(v);
    return Buffer.concat([Buffer.from([i + 1, bytes.length]), bytes]);
  }));
}

export function zatcaBase64(f: ZatcaFields): string {
  return zatcaTlv(f).toString('base64');
}

/** Decodes a phase-1 Base64 payload back into its fields (tests and support tooling). */
export function decodeZatca(b64: string): Record<number, string> {
  const buf = Buffer.from(b64, 'base64');
  const out: Record<number, string> = {};
  for (let i = 0; i + 2 <= buf.length;) {
    const tag = buf[i]!, len = buf[i + 1]!;
    out[tag] = buf.subarray(i + 2, i + 2 + len).toString('utf8');
    i += 2 + len;
  }
  return out;
}

/** Inline SVG of the QR (no network needed in the PDF renderer). */
export function zatcaQrSvg(b64: string, label = 'ZATCA QR') {
  return qrSvg(encodeQr(b64, { ecc: 'M' }), { margin: 2, title: label });
}

/** Whether a VAT number looks configured (Saudi VAT numbers are 15 digits; any non-empty value is accepted here). */
export function hasVatNumber(v: string | null | undefined): v is string {
  return !!v && v.trim().length > 0;
}
