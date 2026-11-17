import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { withSystem } from '../db/client';

/** Rejected webhooks are aggregated into one row per provider, reason and window. */
export const REJECTION_WINDOW_SEC = 600;

/**
 * Records a webhook that failed signature verification (LUMA-AUDIT-026)
 * without letting a flood of junk create one row per request: every rejection
 * for the same provider + reason within a 10-minute window increments ONE
 * provider_events row (signature_valid = false, status 'ignored') holding the
 * count, first/last time and largest body size. Bounded storage, and the
 * monitoring view still sees that forged traffic happened and how much.
 * Events with a VALID signature that LUMA then refuses (amount mismatch,
 * unknown payment, …) are still stored one per event (needs_review), so the
 * audit trail of genuine provider traffic is complete.
 */
export async function recordRejectedWebhook(provider: string, reason: string, bodyLength: number) {
  const bucket = Math.floor(Date.now() / 1000 / REJECTION_WINDOW_SEC) * REJECTION_WINDOW_SEC;
  const reasonKey = createHash('sha256').update(reason).digest('hex').slice(0, 12);
  const id = `rejected:${bucket}:${reasonKey}`;
  const now = new Date().toISOString();
  const payload = JSON.stringify({ reason: reason.slice(0, 200), count: 1, first_at: now, last_at: now, max_length: bodyLength, window_sec: REJECTION_WINDOW_SEC });
  await withSystem('record rejected webhook (aggregated)', (trx) => trx.insertInto('provider_events').values({
    provider, provider_event_id: id, event_type: 'rejected', signature_valid: false, payload, status: 'ignored', error: reason.slice(0, 200),
  }).onConflict((oc) => oc.columns(['provider', 'provider_event_id']).doUpdateSet({
    payload: sql`jsonb_set(jsonb_set(jsonb_set(provider_events.payload,
      '{count}', to_jsonb(coalesce((provider_events.payload->>'count')::int, 1) + 1)),
      '{last_at}', to_jsonb(${now}::text)),
      '{max_length}', to_jsonb(greatest(coalesce((provider_events.payload->>'max_length')::int, 0), ${bodyLength}::int)))`,
  })).execute());
}
