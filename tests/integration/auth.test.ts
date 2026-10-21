import { describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/http';
import * as register from '@/app/api/v1/auth/register/route';
import * as verify from '@/app/api/v1/auth/verify/route';
import * as login from '@/app/api/v1/auth/login/route';
import * as logout from '@/app/api/v1/auth/logout/route';
import * as session from '@/app/api/v1/auth/session/route';
import * as recoveryRequest from '@/app/api/v1/auth/recovery/request/route';
import * as recoveryReset from '@/app/api/v1/auth/recovery/reset/route';
import * as sessions from '@/app/api/v1/auth/sessions/route';

const uniq = () => Math.random().toString(36).slice(2, 10);

describe('authentication', () => {
  it('registers, verifies with the (dev-labelled) code, and signs in', async () => {
    const c = new TestClient();
    const email = `user-${uniq()}@example.test`;
    const r = await c.call(register.POST, { body: { identifier: email, password: 'correct horse battery', display_name: 'سارة' } });
    expect(r.status).toBe(202);
    expect(r.body.data.delivery.status).toBe('simulated');
    const code = r.body.data.delivery.dev_code;
    expect(code).toMatch(/^\d{6}$/);

    const bad = await c.call(verify.POST, { body: { identifier: email, code: code === '000000' ? '111111' : '000000' } });
    expect(bad.status).toBe(422);

    const v = await c.call(verify.POST, { body: { identifier: email, code } });
    expect(v.status).toBe(200);
    const s = await c.call(session.GET);
    expect(s.body.data.user.email_verified).toBe(true);
    expect(s.body.data.platform_capabilities).toEqual([]);

    await c.call(logout.POST, { body: {} });
    expect((await c.call(session.GET)).body.data.user).toBeNull();

    const l = await c.call(login.POST, { body: { identifier: email, password: 'correct horse battery' } });
    expect(l.status).toBe(200);
    expect((await c.call(session.GET)).body.data.user.display_name).toBe('سارة');
  });

  it('rejects mutations without the CSRF header', async () => {
    const c = new TestClient();
    const r = await c.call(login.POST, { body: { identifier: 'x@example.test', password: 'x' }, csrf: false });
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe('csrf');
  });

  it('does not reveal whether an account exists on duplicate registration', async () => {
    const c = new TestClient();
    const email = `dup-${uniq()}@example.test`;
    const a = await c.call(register.POST, { body: { identifier: email, password: 'correct horse battery', display_name: 'A' } });
    const b = await c.call(register.POST, { body: { identifier: email, password: 'another long pass', display_name: 'B' } });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(Object.keys(b.body.data)).toEqual(Object.keys(a.body.data));
  });

  it('locks the account after repeated failures and rate limits', async () => {
    const c = new TestClient();
    const phone = `+9665${Math.floor(10000000 + Math.random() * 89999999)}`;
    await c.call(register.POST, { body: { identifier: phone, password: 'correct horse battery', display_name: 'P' } });
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await c.call(login.POST, { body: { identifier: phone, password: 'wrong password!!' } });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 8).every((s) => s === 422)).toBe(true);
    expect(statuses[8]).toBe(429);
    const ok = await c.call(login.POST, { body: { identifier: phone, password: 'correct horse battery' } });
    expect(ok.status).toBe(429); // locked even with the right password
  });

  it('recovers a password and revokes old sessions', async () => {
    const a = new TestClient();
    const email = `rec-${uniq()}@example.test`;
    const r = await a.call(register.POST, { body: { identifier: email, password: 'correct horse battery', display_name: 'R' } });
    await a.call(verify.POST, { body: { identifier: email, code: r.body.data.delivery.dev_code } });
    expect((await a.call(sessions.GET)).body.data).toHaveLength(1);

    const b = new TestClient();
    const req = await b.call(recoveryRequest.POST, { body: { identifier: email } });
    expect(req.status).toBe(202);
    const code = req.body.data.delivery.dev_code;
    const reset = await b.call(recoveryReset.POST, { body: { identifier: email, code, new_password: 'brand new password' } });
    expect(reset.status).toBe(200);
    // Old session no longer valid
    expect((await a.call(session.GET)).body.data.user).toBeNull();
    // Code cannot be reused
    const again = await b.call(recoveryReset.POST, { body: { identifier: email, code, new_password: 'another new password' } });
    expect(again.status).toBe(422);
    expect((await b.call(login.POST, { body: { identifier: email, password: 'brand new password' } })).status).toBe(200);
  });

  it('recovery responds identically for unknown accounts', async () => {
    const c = new TestClient();
    const r = await c.call(recoveryRequest.POST, { body: { identifier: `nobody-${uniq()}@example.test` } });
    expect(r.status).toBe(202);
    expect(r.body.data.delivery.dev_code).toBeUndefined();
  });
});
