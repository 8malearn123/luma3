import { checkRuntimeRole } from '@/server/db/role-guard';
import { env } from '@/server/env';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };

/** Error codes only (pg SQLSTATE such as 28P01, or network codes such as ENOTFOUND) — never messages or values. */
function errorCode(e: unknown) {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,20}$/.test(code) ? code : 'unknown';
}

/**
 * GET /api/v1/health — liveness, a database round-trip, and whether row-level
 * security applies to the connected role. On failure it names the failing
 * setting or the error code (never a value), so a misconfigured host can be
 * diagnosed without server logs.
 */
export async function GET() {
  // Whether a hosting integration injected a database connection at all (true/false only).
  const injected = Boolean(process.env.LUMA_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL);
  let deployed = false;
  try {
    deployed = env().isDeployed;
  } catch (e) {
    const missing = [...String((e as Error).message).matchAll(/([A-Z][A-Z0-9_]+):/g)].map((m) => m[1]);
    return Response.json({ ok: false, db: 'down', reason: 'config', settings: missing, database_injected: injected }, { status: 503, headers });
  }
  try {
    const role = await checkRuntimeRole();
    const rls = role.safe ? 'enforced' : 'bypassed';
    const ok = role.safe || !deployed;
    return Response.json({ ok, db: 'up', rls }, { status: ok ? 200 : 503, headers });
  } catch (e) {
    console.error('[health] database check failed:', errorCode(e));
    return Response.json({ ok: false, db: 'down', reason: 'connect', error: errorCode(e), database_injected: injected }, { status: 503, headers });
  }
}
