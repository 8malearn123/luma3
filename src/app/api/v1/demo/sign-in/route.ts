import { sql } from 'kysely';
import { z } from 'zod';
import { db, withCentral } from '@/server/db/client';
import { env } from '@/server/env';
import { route, sessionCookie } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { createSession } from '@/server/auth/service';
import { audit } from '@/server/infra/audit';

/**
 * PRIVATE DEMO ONLY — signs in as a seeded demo identity (is_demo = true).
 * Refuses in production and for any real account.
 */
export const POST = route({
  auth: 'public',
  input: z.object({ key: z.string().uuid() }),
  rateLimit: { scope: 'ip', name: 'demo_sign_in', limit: 60, windowSec: 600 },
  handler: async ({ input, ip, userAgent, responseInit }) => {
    if (!env().demoEnabled) throw Errors.notFound();
    const u = await db().selectFrom('users').select(['id', 'is_demo']).where('id', '=', input.key).where('is_demo', '=', true).where('status', '=', 'active').executeTakeFirst();
    if (!u) throw Errors.notFound();
    const s = await createSession(u.id, ip, userAgent);
    responseInit.cookies.push(sessionCookie(s.token, s.expiresAt));
    await withCentral((trx) => audit(trx, { userId: u.id, kind: 'user', ip }, 'auth.demo_sign_in', { targetType: 'user', targetId: u.id }));
    const pr = await db().selectFrom('platform_roles').select('role').where('user_id', '=', u.id).where('revoked_at', 'is', null).executeTakeFirst();
    const m = (await sql<{ tenant_slug: string; role: string }>`select tenant_slug, role from app.memberships_for_user(${u.id}) limit 1`.execute(db())).rows[0];
    const redirect = pr ? '/platform' : m ? (m.role === 'specialist' ? '/staff' : `/app/${m.tenant_slug}`) : '/account';
    return { data: { redirect } };
  },
});
