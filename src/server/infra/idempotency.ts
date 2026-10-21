import { createHash } from 'node:crypto';
import type { Tx } from '../db/client';
import { AppError, Errors } from '../http/errors';

export function requestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

/**
 * Idempotent execution inside the caller's transaction:
 *  - first request inserts an in_progress record, runs fn, stores the result;
 *  - a concurrent duplicate waits on the unique index until the first commits,
 *    then replays the stored result (if the first rolled back, it proceeds);
 *  - the same key with a different payload is rejected (422).
 * Because the record lives in the same transaction, a failed operation leaves
 * no record and the client can safely retry with the same key.
 */
export async function idempotent<T>(
  trx: Tx,
  opts: { scope: string; operation: string; key: string; hash: string },
  fn: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!/^[A-Za-z0-9_\-:.]{8,200}$/.test(opts.key)) throw Errors.invalid('invalid_idempotency_key', 'Idempotency-Key must be 8-200 safe characters');
  // ON CONFLICT DO NOTHING waits for a concurrent duplicate to commit (or roll
  // back) without aborting this transaction; under READ COMMITTED the follow-up
  // SELECT then sees the committed record and replays it.
  const inserted = await trx
    .insertInto('idempotency_records')
    .values({ scope: opts.scope, operation: opts.operation, key: opts.key, request_hash: opts.hash, status: 'in_progress' })
    .onConflict((oc) => oc.columns(['scope', 'operation', 'key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) {
    const existing = await trx
      .selectFrom('idempotency_records')
      .selectAll()
      .where('scope', '=', opts.scope)
      .where('operation', '=', opts.operation)
      .where('key', '=', opts.key)
      .executeTakeFirstOrThrow();
    return replay(existing, opts.hash);
  }
  const result = await fn();
  await trx.updateTable('idempotency_records')
    .set({ status: 'completed', response_status: result.status, response_body: JSON.stringify(result.body ?? null) })
    .where('scope', '=', opts.scope).where('operation', '=', opts.operation).where('key', '=', opts.key)
    .execute();
  return { ...result, replayed: false };
}

function replay<T>(rec: { request_hash: string; status: string; response_status: number | null; response_body: unknown }, hash: string) {
  if (rec.request_hash !== hash) {
    throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was used with a different request');
  }
  if (rec.status !== 'completed') throw Errors.conflict('request_in_progress', 'The same request is already being processed');
  return { status: rec.response_status ?? 200, body: rec.response_body as T, replayed: true };
}
