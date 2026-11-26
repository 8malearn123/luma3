import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s) — what an authenticator app would
 * show for the secret LUMA displays during enrolment. Kept independent of the
 * server implementation so the browser test checks it from the outside.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/[\s=]+/g, '')) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpAt(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

const used = new Map<string, number>();
/**
 * A code for the current step that this test has not used yet for `secret`
 * (servers refuse a replayed step), waiting for the next step when needed.
 * Also avoids the last 3 s of a step so the code is still valid on arrival.
 */
export async function freshTotp(secret: string): Promise<string> {
  for (;;) {
    const now = Date.now() / 1000;
    const counter = Math.floor(now / 30);
    if ((used.get(secret) ?? -1) < counter && now % 30 < 27) {
      used.set(secret, counter);
      return totpAt(secret, counter);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
