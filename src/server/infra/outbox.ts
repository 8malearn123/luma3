import type { Tx } from '../db/client';

/**
 * Transactional outbox: side effects (notifications, emails, analytics fan-out)
 * are recorded in the same transaction as the state change, then delivered by
 * the worker. A committed booking can never "lose" its confirmation message.
 */
export async function enqueue(trx: Tx, topic: string, payload: Record<string, unknown>, opts: { tenantId?: string | null; dedupeKey?: string } = {}) {
  await trx
    .insertInto('outbox_events')
    .values({ topic, payload: JSON.stringify(payload), tenant_id: opts.tenantId ?? null, dedupe_key: opts.dedupeKey ?? null })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .execute();
}

/** Schedules a background job (deduplicated). */
export async function schedule(trx: Tx, kind: string, payload: Record<string, unknown>, opts: { tenantId?: string | null; runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
  await trx
    .insertInto('job_runs')
    .values({
      kind, payload: JSON.stringify(payload), tenant_id: opts.tenantId ?? null, run_at: opts.runAt ?? new Date(),
      dedupe_key: opts.dedupeKey ?? null, max_attempts: opts.maxAttempts ?? 5,
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .execute();
}
