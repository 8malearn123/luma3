import { sql } from 'kysely';
import { db } from '@/server/db/client';

export const dynamic = 'force-dynamic';

/** GET /api/v1/health — liveness plus a database round-trip. Reveals no configuration. */
export async function GET() {
  try {
    await sql`select 1`.execute(db());
    return Response.json({ ok: true, db: 'up' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, db: 'down' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
