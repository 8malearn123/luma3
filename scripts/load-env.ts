import { existsSync, readFileSync } from 'node:fs';

/** Minimal .env loader for CLI scripts (Next.js loads .env itself). Existing vars win. */
export function loadDotEnv(file = '.env') {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, key, rawValue] = m;
    if (process.env[key!] !== undefined) continue;
    process.env[key!] = rawValue!.replace(/^"(.*)"$/, '$1');
  }
}
