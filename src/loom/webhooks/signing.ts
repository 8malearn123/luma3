import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Loom webhook signatures (inbound ingest and outgoing events share one scheme):
 *   X-Loom-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *   X-Loom-Event-Id:  <unique event id>   (idempotency key)
 * Receivers reject timestamps outside the tolerance (replay protection) and
 * compare signatures in constant time.
 */
export const SIGNATURE_HEADER = 'x-loom-signature';
export const EVENT_ID_HEADER = 'x-loom-event-id';
export const DEFAULT_TOLERANCE_SEC = 300;

export function newWebhookSecret() { return `whsec_${randomBytes(24).toString('base64url')}`; }

export function signBody(secret: string, body: string, t: number) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export class SignatureError extends Error {
  constructor(public code: 'missing_signature' | 'bad_signature' | 'stale_timestamp') { super(code); }
}

/** Verifies a signature header; returns the signed timestamp (seconds). */
export function verifySignature(secret: string, body: string, header: string | null, opts: { now?: Date; toleranceSec?: number } = {}): number {
  if (!header) throw new SignatureError('missing_signature');
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]).filter((p) => p.length === 2));
  const t = Number(parts.t);
  const v1 = parts.v1 ?? '';
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) throw new SignatureError('bad_signature');
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC)) throw new SignatureError('stale_timestamp');
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const got = Buffer.from(v1, 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new SignatureError('bad_signature');
  return t;
}
