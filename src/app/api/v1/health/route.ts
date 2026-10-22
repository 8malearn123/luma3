import { checkRuntimeRole } from '@/server/db/role-guard';
import { env } from '@/server/env';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/health — liveness, a database round-trip, and whether row-level
 * security applies to the connected role. Reveals no names or configuration values.
 */
export async function GET() {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const role = await checkRuntimeRole();
    const rls = role.safe ? 'enforced' : 'bypassed';
    const ok = role.safe || !env().isDeployed;
    return Response.json({ ok, db: 'up', rls }, { status: ok ? 200 : 503, headers });
  } catch {
    return Response.json({ ok: false, db: 'down' }, { status: 503, headers });
  }
}
