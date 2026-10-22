import { hostname } from 'node:os';
import { sql } from 'kysely';
import { withSystem } from '../db/client';
import { PermanentJobError, registry } from './registry';
import './index';

const WORKER_ID = `${hostname()}:${process.pid}`;

/** Exponential backoff with jitter, capped at 30 minutes. */
export function backoffSec(attempt: number) {
  return Math.min(1800, 2 ** attempt * 15) + Math.floor(Math.random() * 10);
}

/** Claims and runs up to `limit` due jobs. Safe to run in several processes (SKIP LOCKED). */
export async function runDueJobs(limit = 10) {
  const claimed = await withSystem('claim due jobs', (trx) => sql<{ id: string; kind: string; payload: Record<string, unknown>; tenant_id: string | null; attempts: number; max_attempts: number }>`
    update job_runs set status = 'running', locked_by = ${WORKER_ID}, locked_at = now(), attempts = attempts + 1
    where id in (select id from job_runs where status = 'queued' and run_at <= now() order by run_at limit ${limit} for update skip locked)
    returning id, kind, payload, tenant_id, attempts, max_attempts`.execute(trx));
  let done = 0;
  for (const job of claimed.rows) {
    const handler = registry.jobs.get(job.kind);
    try {
      if (!handler) throw new PermanentJobError(`no handler for ${job.kind}`);
      const result = await handler(job.payload, { jobId: job.id, tenantId: job.tenant_id, attempt: job.attempts });
      await withSystem('finish job', (trx) => trx.updateTable('job_runs').set({ status: 'succeeded', finished_at: new Date(), result: JSON.stringify(result ?? {}), last_error: null }).where('id', '=', job.id).execute());
      done++;
    } catch (e) {
      const permanent = e instanceof PermanentJobError || job.attempts >= job.max_attempts;
      await withSystem('fail job', (trx) => trx.updateTable('job_runs').set({
        status: permanent ? 'failed' : 'queued',
        run_at: new Date(Date.now() + backoffSec(job.attempts) * 1000),
        last_error: (e as Error).message.slice(0, 1000), locked_by: null, locked_at: null,
        ...(permanent ? { finished_at: new Date() } : {}),
      }).where('id', '=', job.id).execute());
    }
  }
  return { claimed: claimed.rows.length, succeeded: done };
}

/** Delivers pending outbox events to registered topic handlers (at-least-once; handlers must be idempotent). */
export async function runOutbox(limit = 50) {
  const events = await withSystem('claim outbox', (trx) => sql<{ id: string; topic: string; payload: Record<string, unknown>; tenant_id: string | null; attempts: number }>`
    update outbox_events set attempts = attempts + 1, available_at = now() + interval '5 minutes'
    where id in (select id from outbox_events where processed_at is null and available_at <= now() and attempts < 10 order by created_at limit ${limit} for update skip locked)
    returning id, topic, payload, tenant_id, attempts`.execute(trx));
  for (const ev of events.rows) {
    try {
      for (const h of registry.outbox.get(ev.topic) ?? []) await h({ id: ev.id, tenantId: ev.tenant_id, topic: ev.topic, payload: ev.payload });
      await withSystem('ack outbox', (trx) => trx.updateTable('outbox_events').set({ processed_at: new Date(), last_error: null }).where('id', '=', ev.id).execute());
    } catch (e) {
      await withSystem('nack outbox', (trx) => trx.updateTable('outbox_events').set({ last_error: (e as Error).message.slice(0, 1000), available_at: new Date(Date.now() + backoffSec(ev.attempts) * 1000) }).where('id', '=', ev.id).execute());
    }
  }
  return events.rows.length;
}

/**
 * Runs each periodic task whose interval has elapsed. The claim is an atomic
 * upsert in `periodic_runs`, so concurrent workers or serverless invocations
 * run a task at most once per interval.
 */
export async function runPeriodic(now = new Date()) {
  const ran: string[] = [];
  for (const task of registry.periodic) {
    const claimed = await withSystem('claim periodic task', (trx) => sql<{ name: string }>`
      insert into periodic_runs (name, last_started_at) values (${task.name}, ${now})
      on conflict (name) do update set last_started_at = excluded.last_started_at
        where periodic_runs.last_started_at <= ${now}::timestamptz - make_interval(secs => ${task.everySec})
      returning name`.execute(trx));
    if (!claimed.rows.length) continue;
    ran.push(task.name);
    try { await task.run(); } catch (e) { console.error(`[periodic:${task.name}]`, (e as Error).message); }
  }
  return ran;
}
