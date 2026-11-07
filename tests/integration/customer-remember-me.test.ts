import { describe, expect, it } from 'vitest';
import { signup } from '../helpers/factory';
import { TestClient } from '../helpers/http';
import { db } from '@/server/db/client';
import { resolveSession } from '@/server/auth/service';
import * as login from '@/app/api/v1/auth/login/route';
import * as logout from '@/app/api/v1/auth/logout/route';

const DAY = 86_400_000;

function sessionSetCookie(headers: Headers) {
  return headers.getSetCookie().find((c) => c.startsWith('luma_session='))!;
}
const expiresOf = (cookie: string) => {
  const m = /expires=([^;]+)/i.exec(cookie);
  return m ? new Date(m[1]!).getTime() : null;
};

describe('«تذكريني» (remember me)', () => {
  it('checked: a 30-day cookie and server session; unchecked: a browser-session cookie with a short server lifetime', async () => {
    const u = await signup('Remember');
    const a = new TestClient();
    const t0 = Date.now();
    const remembered = await a.call(login.POST, { body: { identifier: u.identifier, password: 'correct horse battery', remember: true } });
    expect(remembered.status).toBe(200);
    expect(remembered.body.data.remember).toBe(true);
    const c1 = sessionSetCookie(remembered.headers);
    expect(c1).toMatch(/HttpOnly/i);
    expect(c1).toMatch(/SameSite=lax/i);
    const exp = expiresOf(c1)!;
    expect(exp).toBeGreaterThan(t0 + 29.9 * DAY);
    expect(exp).toBeLessThan(t0 + 30.1 * DAY);
    const s1 = await resolveSession(a.cookies.get('luma_session'));
    const row1 = await db().selectFrom('sessions').select(['persistent', 'expires_at', 'idle_expires_at']).where('id', '=', s1!.sessionId).executeTakeFirstOrThrow();
    expect(row1.persistent).toBe(true);
    expect(row1.expires_at.getTime() - t0).toBeGreaterThan(29.9 * DAY);
    expect(row1.idle_expires_at.getTime() - t0).toBeGreaterThan(6.9 * DAY);

    const b = new TestClient();
    const plain = await b.call(login.POST, { body: { identifier: u.identifier, password: 'correct horse battery' } });
    expect(plain.status).toBe(200);
    expect(plain.body.data.remember).toBe(false);
    const c2 = sessionSetCookie(plain.headers);
    // Session cookie: no Expires / Max-Age, so it ends with the browser.
    expect(c2).not.toMatch(/expires=/i);
    expect(c2).not.toMatch(/max-age=/i);
    const s2 = await resolveSession(b.cookies.get('luma_session'));
    const row2 = await db().selectFrom('sessions').select(['persistent', 'expires_at', 'idle_expires_at']).where('id', '=', s2!.sessionId).executeTakeFirstOrThrow();
    expect(row2.persistent).toBe(false);
    expect(row2.expires_at.getTime() - t0).toBeLessThanOrEqual(24 * 3_600_000 + 60_000);
    expect(row2.idle_expires_at.getTime() - t0).toBeLessThanOrEqual(12 * 3_600_000 + 60_000);

    // Rotation: every sign-in issues a new session and token; revocation still works for both kinds.
    expect(a.cookies.get('luma_session')).not.toBe(b.cookies.get('luma_session'));
    expect(s1!.sessionId).not.toBe(s2!.sessionId);
    await b.call(logout.POST, { body: {} });
    const plainToken = /^luma_session=([^;]+)/.exec(c2)![1];
    expect(await resolveSession(plainToken)).toBeNull();
    const revoked = await db().selectFrom('sessions').select('revoked_at').where('id', '=', s2!.sessionId).executeTakeFirstOrThrow();
    expect(revoked.revoked_at).not.toBeNull();
    expect(await resolveSession(a.cookies.get('luma_session'))).not.toBeNull();

    // A non-persistent session past its server-side cap is rejected even if the browser kept the cookie.
    const c = new TestClient();
    await c.call(login.POST, { body: { identifier: u.identifier, password: 'correct horse battery', remember: false } });
    const token = c.cookies.get('luma_session');
    const s3 = await resolveSession(token);
    await db().updateTable('sessions').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', s3!.sessionId).execute();
    expect(await resolveSession(token)).toBeNull();
  });
});
