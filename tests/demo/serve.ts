import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Serves the embedded demo deployment the way Vercel runs it when no database
 * is attached: the deploy-time snapshot (scripts/build-demo-db.ts), a
 * production build, and TWO server instances that each hold their own copy of
 * the data. A proxy in front sends each request to the next instance in turn
 * (separate serverless instances), or always to the first one when the request
 * carries `x-demo-route: sticky` (one warm instance).
 */
export const DEMO_PORT = Number(process.env.DEMO_PORT ?? 3300);
const INSTANCES = [DEMO_PORT + 1, DEMO_PORT + 2];
const DIST = '.next-demo';

export function demoEnv(secret: string): Record<string, string> {
  return {
    APP_ENV: 'review',
    APP_URL: `http://localhost:${DEMO_PORT}`,
    DB_DRIVER: 'pglite',
    DATABASE_URL: 'pglite://embedded',
    DB_APP_ROLE: 'luma_app',
    AUTH_SECRET: secret,
    PAYMENT_SANDBOX_WEBHOOK_SECRET: `${secret}-sandbox`,
    STORAGE_DRIVER: 'db',
    DEMO_MODE: 'true',
    DEV_OTP_ECHO: 'true',
    NEXT_DIST_DIR: DIST,
  };
}

function build() {
  // A fresh snapshot with a known secret, then a production build into its own dist dir.
  rmSync('.demo-db', { recursive: true, force: true });
  mkdirSync('.demo-db', { recursive: true });
  writeFileSync(path.join('.demo-db', 'secret'), `demo-e2e-${Date.now()}-secret-secret-secret`, { mode: 0o600 });
  const secret = readFileSync(path.join('.demo-db', 'secret'), 'utf8');
  const env = { ...process.env, ...demoEnv(secret) };
  execFileSync('pnpm', ['-s', 'exec', 'tsx', 'scripts/build-demo-db.ts'], { env, stdio: 'inherit' });
  execFileSync('pnpm', ['-s', 'exec', 'next', 'build'], { env, stdio: 'inherit' });
  return secret;
}

function startInstances(secret: string): ChildProcess[] {
  return INSTANCES.map((port) => spawn('pnpm', ['-s', 'exec', 'next', 'start', '-p', String(port)], {
    env: { ...process.env, ...demoEnv(secret) }, stdio: 'inherit',
  }));
}

function startProxy() {
  let n = 0;
  http.createServer((req, res) => {
    const sticky = req.headers['x-demo-route'] === 'sticky';
    const port = sticky ? INSTANCES[0]! : INSTANCES[n++ % INSTANCES.length]!;
    const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(upstream);
  }).listen(DEMO_PORT);
}

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    const ok = await Promise.all(INSTANCES.map((p) => fetch(`http://127.0.0.1:${p}/api/v1/health`).then((r) => r.ok, () => false)));
    if (ok.every(Boolean)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('demo instances did not become healthy');
}

if (process.argv[1]?.endsWith('serve.ts')) {
  const secret = build();
  const children = startInstances(secret);
  const stop = () => { for (const c of children) c.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await waitHealthy();
  startProxy();
  console.log(`[demo] embedded demo on http://localhost:${DEMO_PORT} (instances ${INSTANCES.join(', ')})`);
}
