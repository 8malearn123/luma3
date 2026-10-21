import { db, sql } from '../db/client';
import { Errors } from '../http/errors';

/**
 * Fixed-window counter stored in Postgres so limits hold across app instances.
 * Atomic upsert: the window resets when it has elapsed.
 */
export async function hit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; retryAfterSec: number; count: number }> {
  const res = await sql<{ count: number; window_start: Date }>`
    insert into rate_limit_buckets (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when rate_limit_buckets.window_start < now() - make_interval(secs => ${windowSec}) then 1 else rate_limit_buckets.count + 1 end,
      window_start = case when rate_limit_buckets.window_start < now() - make_interval(secs => ${windowSec}) then now() else rate_limit_buckets.window_start end
    returning count, window_start`.execute(db());
  const row = res.rows[0]!;
  const elapsed = (Date.now() - new Date(row.window_start).getTime()) / 1000;
  return { allowed: row.count <= limit, retryAfterSec: Math.max(1, Math.ceil(windowSec - elapsed)), count: row.count };
}

export async function enforce(key: string, limit: number, windowSec: number) {
  const r = await hit(key, limit, windowSec);
  if (!r.allowed) throw Errors.rateLimited(r.retryAfterSec);
}

export async function resetKey(key: string) {
  await db().deleteFrom('rate_limit_buckets').where('key', '=', key).execute();
}
