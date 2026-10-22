import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../env';

/**
 * TOTP (RFC 6238 over RFC 4226 HOTP) with HMAC-SHA1, 6 digits, 30-second steps:
 * the parameters every authenticator app supports. Secrets are encrypted at
 * rest with AES-256-GCM using a key derived from AUTH_SECRET via HKDF.
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SEC = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160-bit, as recommended by RFC 4226
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpStep(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SEC);
}

export function totpCode(secretB32: string, atMs = Date.now()) {
  return hotp(base32Decode(secretB32), totpStep(atMs));
}

/**
 * Verifies a code within ±window steps (clock drift). Returns the matched step
 * so callers can reject reuse of the same or an older step.
 */
export function verifyTotp(secretB32: string, code: string, opts: { atMs?: number; window?: number; afterStep?: number | null } = {}): number | null {
  const c = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32);
  const now = totpStep(opts.atMs ?? Date.now());
  const w = opts.window ?? 1;
  for (let s = now - w; s <= now + w; s++) {
    if (opts.afterStep != null && s <= opts.afterStep) continue;
    const expected = Buffer.from(hotp(secret, s));
    if (timingSafeEqual(expected, Buffer.from(c))) return s;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer = 'LUMA') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SEC}`;
}

// ── Encryption at rest ──────────────────────────────────────────────────────
function key(): Buffer {
  return Buffer.from(hkdfSync('sha256', env().AUTH_SECRET, 'luma-mfa-v1', 'totp-secret-encryption', 32));
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, ct] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
