import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

/**
 * E2E web server (LUMA-AUDIT-043): `next start` AND the background job worker
 * (scripts/worker.ts), so Loom analyses, plan preparation and booking-hold
 * expiry really progress during Playwright runs.
 *
 * Playwright starts this before globalSetup rebuilds and seeds the database,
 * so the worker waits for the marker global-setup writes when seeding is done
 * (a stale marker from an earlier run is removed first). Stopping this process
 * stops both children. Set E2E_WORKER=0 to run without the worker.
 */
export const SEEDED_MARKER = '.e2e/seeded';
const PORT = process.env.E2E_PORT ?? '3110';
const children: ChildProcess[] = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

rmSync(SEEDED_MARKER, { force: true });
const app = spawn('pnpm', ['exec', 'next', 'start', '-p', PORT], { stdio: 'inherit', env: process.env });
children.push(app);
app.on('exit', (code) => stop(code ?? 1));

if (process.env.E2E_WORKER !== '0') {
  const wait = setInterval(() => {
    if (stopping) return clearInterval(wait);
    if (!existsSync(SEEDED_MARKER)) return;
    clearInterval(wait);
    const worker = spawn('pnpm', ['exec', 'tsx', 'scripts/worker.ts'], { stdio: 'inherit', env: process.env });
    children.push(worker);
    worker.on('exit', (code) => { if (!stopping) console.error(`[e2e-serve] worker exited (${code})`); });
  }, 1000);
}
