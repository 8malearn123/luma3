import { timingSafeEqual } from 'node:crypto';
import { env } from '@/server/env';
import { runDueJobs, runOutbox, runPeriodic } from '@/server/jobs/runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Time budget per call, leaving headroom below the platform's function timeout. */
const BUDGET_MS = 45_000;

function authorised(header: string | null) {
  const secret = env().CRON_SECRET;
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * GET /api/v1/internal/cron — one pass of the background worker for hosts that
 * cannot run `scripts/worker.ts` (e.g. Vercel). Called on a schedule with
 * `Authorization: Bearer $CRON_SECRET`; without CRON_SECRET it does not exist (404).
 * Safe to call concurrently: jobs use SKIP LOCKED and periodic tasks are claimed in the DB.
 */
export async function GET(req: Request) {
  if (!authorised(req.headers.get('authorization'))) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  const started = Date.now();
  const periodic = await runPeriodic();
  let outbox = 0;
  let jobs = 0;
  while (Date.now() - started < BUDGET_MS) {
    const o = await runOutbox();
    const j = await runDueJobs();
    outbox += o;
    jobs += j.claimed;
    if (!o && !j.claimed) break;
  }
  return Response.json({ ok: true, periodic, outbox, jobs, ms: Date.now() - started }, { headers: { 'Cache-Control': 'no-store' } });
}
