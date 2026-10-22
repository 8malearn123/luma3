import { loadDotEnv } from './load-env';

loadDotEnv();
const { runDueJobs, runOutbox, runPeriodic } = await import('../src/server/jobs/runner');

/** Background worker: jobs (retries/backoff), transactional outbox, periodic sweepers. */
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
console.log('[worker] started');
while (!stopping) {
  try {
    await runPeriodic();
    const o = await runOutbox();
    const j = await runDueJobs();
    if (!o && !j.claimed) await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    console.error('[worker]', (e as Error).message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
console.log('[worker] stopped');
process.exit(0);
