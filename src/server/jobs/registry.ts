import type { Tx } from '../db/client';

/**
 * Background work registry. Domains register:
 *  - job handlers (kind → handler) for rows in job_runs (retries, backoff, dedupe);
 *  - outbox topic handlers for transactional side effects;
 *  - periodic tasks (sweepers) run by the worker on an interval.
 * Every handler receives the tenant id it must operate on and re-verifies scope.
 */
export type JobContext = { jobId: string; tenantId: string | null; attempt: number };
export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<Record<string, unknown> | void>;
export type OutboxHandler = (event: { id: string; tenantId: string | null; topic: string; payload: Record<string, unknown> }) => Promise<void>;
export type PeriodicTask = { name: string; everySec: number; run: () => Promise<void> };

const jobs = new Map<string, JobHandler>();
const outbox = new Map<string, OutboxHandler[]>();
const periodic: PeriodicTask[] = [];

export function registerJob(kind: string, handler: JobHandler) {
  jobs.set(kind, handler);
}
export function registerOutbox(topic: string, handler: OutboxHandler) {
  outbox.set(topic, [...(outbox.get(topic) ?? []), handler]);
}
export function registerPeriodic(task: PeriodicTask) {
  if (!periodic.some((p) => p.name === task.name)) periodic.push(task);
}

export const registry = { jobs, outbox, periodic };

/** Error type that tells the runner not to retry (permanent failure). */
export class PermanentJobError extends Error {}

export type { Tx };
