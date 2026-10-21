import { createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../env';

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

// scrypt parameters (OWASP-recommended minimum N=2^17 needs 128MB; we use
// 2^15 with r=8 ≈ 32MB per hash, balancing serverless memory limits).
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Spend comparable time so unknown accounts are not distinguishable by timing.
    await scrypt(password, randomBytes(16), KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
    return false;
  }
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Opaque random token for cookies/links. Only its keyed hash is stored. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Keyed hash (HMAC-SHA256 with AUTH_SECRET) so a DB leak alone cannot replay tokens. */
export function hashToken(token: string, purpose = 'token'): Buffer {
  return createHmac('sha256', env().AUTH_SECRET).update(`${purpose}:${token}`).digest();
}

/** Numeric one-time code. */
export function newOtp(digits = 6): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

export function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Gift card / human-readable high-entropy code: 16 chars from an unambiguous alphabet (~80 bits). */
export function newHumanCode(groups = 4, groupLen = 4): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    for (let i = 0; i < groupLen; i++) s += alphabet[randomInt(0, alphabet.length)];
    parts.push(s);
  }
  return parts.join('-');
}

export function normalizeHumanCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function maskDestination(dest: string): string {
  if (dest.includes('@')) {
    const [user, domain] = dest.split('@');
    return `${(user ?? '').slice(0, 2)}***@${domain}`;
  }
  return `${dest.slice(0, 4)}****${dest.slice(-2)}`;
}
