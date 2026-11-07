/**
 * سوق لوما — pure rules shared by the marketplace domain, routes and tests.
 * See docs/MARKETPLACE.md.
 */

export const DOC_KINDS = ['commercial_register', 'freelance_document', 'owner_id', 'iban'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const BUSINESS_TYPES = ['salon', 'beauty_center', 'spa', 'expert'] as const;
/** The "salons" door groups every business with premises; "experts" is independent experts. */
export const DOORS = { salons: ['salon', 'beauty_center', 'spa'], experts: ['expert'] } as const;
export type Door = keyof typeof DOORS;

/**
 * Required verification documents by business type (DECISIONS_2026-11):
 * salon → commercial register; expert → freelance document (وثيقة العمل الحر);
 * everyone → owner ID and IBAN.
 */
export function requiredDocKinds(businessType: string): DocKind[] {
  return [businessType === 'expert' ? 'freelance_document' : 'commercial_register', 'owner_id', 'iban'];
}

/** ISO 13616 IBAN check (mod-97). Saudi IBANs are SA + 22 characters. */
export function normalizeIban(raw: string): string | null {
  const v = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(v)) return null;
  if (v.startsWith('SA') && v.length !== 24) return null;
  const moved = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of code) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1 ? v : null;
}

export function maskIban(iban: string | null | undefined) {
  return iban ? `${iban.slice(0, 4)} •••• ${iban.slice(-4)}` : null;
}

/** Half-up basis-point fee in integer minor units (same rounding as deposits). */
export function feeFor(baseMinor: number, rateBp: number) {
  return Math.min(baseMinor, Math.floor((baseMinor * rateBp + 5000) / 10000));
}

/** Detects the real file type from its content (never the name or client MIME). */
export function sniffDocument(data: Buffer): 'pdf' | 'image' | null {
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  const b = data;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image'; // JPEG
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image'; // PNG
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image';
  if (b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') return 'image'; // HEIC/AVIF
  return null;
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Marketplace link parameter carried from /discover to the storefront. */
export const MARKET_REF_PARAM = 'via';
export const MARKET_REF_VALUE = 'luma_market';
/** A marketplace visit attributes bookings started in the same analytics session within this window. */
export const ATTRIBUTION_WINDOW_HOURS = 24;
