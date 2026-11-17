import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createBusinessFor, signup } from '../helpers/factory';
import { db, withTenant } from '@/server/db/client';
import { resetEnvCache } from '@/server/env';
import { previewInvitation } from '@/server/domains/team/service';
import { hashToken } from '@/server/auth/crypto';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as invitationOne from '@/app/api/v1/t/[tenantSlug]/invitations/[id]/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import * as session from '@/app/api/v1/auth/session/route';

/** LUMA-AUDIT-005: staff invitation acceptance — recipient, tenant, role and every invalid state. */
async function setup(role = 'receptionist') {
  const owner = await signup('Invite owner');
  const biz = await createBusinessFor(owner);
  const invitee = await signup('Invitee');
  const inv = await owner.call(invitations.POST, { params: { tenantSlug: biz.slug }, body: { identifier: invitee.identifier, role } });
  expect(inv.status).toBe(201);
  const token = (inv.body.data.invite_link as string).split('/invite/')[1]!;
  return { owner, biz, invitee, inv: inv.body.data as { id: string; invite_link: string }, token };
}

async function rolesOf(c: Awaited<ReturnType<typeof signup>>) {
  return (await c.call(session.GET)).body.data.memberships as Array<{ tenant_slug: string; role: string }>;
}

describe('staff invitations', () => {
  afterEach(() => {
    process.env.APP_ENV = 'test'; process.env.DEV_OTP_ECHO = 'true';
    process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = 'test-webhook-secret'; resetEnvCache();
  });

  it('the intended recipient accepts and joins the inviting business with the invited role', async () => {
    const { biz, invitee, token } = await setup('receptionist');
    const p = await previewInvitation(token, null);
    expect(p).toMatchObject({ state: 'valid', role: 'receptionist', business_name: 'صالون تجريبي', matches_user: false });
    expect(p.destination).toContain('***@');
    const r = await invitee.call(accept.POST, { body: { token } });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ tenant_slug: biz.slug, role: 'receptionist' });
    expect(await rolesOf(invitee)).toEqual([expect.objectContaining({ tenant_slug: biz.slug, role: 'receptionist' })]);
  });

  it('role and tenant come only from the invitation record (extra body fields cannot escalate)', async () => {
    const { invitee, token, biz } = await setup('receptionist');
    const other = await createBusinessFor(await signup('Other owner'));
    const r = await invitee.call(accept.POST, { body: { token, role: 'owner', tenant_slug: other.slug, tenant_id: other.tenantId, granted_capabilities: ['team.manage'] } });
    expect(r.status).toBe(200);
    expect(r.body.data.role).toBe('receptionist');
    const m = await rolesOf(invitee);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ tenant_slug: biz.slug, role: 'receptionist' });
  });

  it('someone else signed in cannot use the link (identity must match the verified contact)', async () => {
    const { token } = await setup();
    const stranger = await signup('Stranger');
    const r = await stranger.call(accept.POST, { body: { token } });
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe('identity_mismatch');
    expect(await rolesOf(stranger)).toEqual([]);
  });

  it('signed-out callers are refused', async () => {
    const { token } = await setup();
    const { TestClient } = await import('../helpers/http');
    expect((await new TestClient().call(accept.POST, { body: { token } })).status).toBe(401);
  });

  it('already used, revoked, expired and unknown links are refused with their state', async () => {
    const used = await setup();
    expect((await used.invitee.call(accept.POST, { body: { token: used.token } })).status).toBe(200);
    const again = await used.invitee.call(accept.POST, { body: { token: used.token } });
    expect(again.status).toBe(422);
    expect(again.body.error.details.reason).toBe('accepted');
    expect((await previewInvitation(used.token)).state).toBe('accepted');

    const revoked = await setup();
    expect((await revoked.owner.call(invitationOne.DELETE, { method: 'DELETE', params: { tenantSlug: revoked.biz.slug, id: revoked.inv.id } })).status).toBe(200);
    const rr = await revoked.invitee.call(accept.POST, { body: { token: revoked.token } });
    expect(rr.status).toBe(422);
    expect(rr.body.error.details.reason).toBe('revoked');
    expect((await previewInvitation(revoked.token)).state).toBe('revoked');

    const expired = await setup();
    await withTenant(expired.biz.tenantId, (trx) => trx.updateTable('invitations').set({ expires_at: new Date(Date.now() - 60_000) }).where('id', '=', expired.inv.id).execute());
    const er = await expired.invitee.call(accept.POST, { body: { token: expired.token } });
    expect(er.status).toBe(422);
    expect(er.body.error.details.reason).toBe('expired');
    expect((await previewInvitation(expired.token)).state).toBe('expired');

    const bogus = 'x'.repeat(43);
    const br = await expired.invitee.call(accept.POST, { body: { token: bogus } });
    expect(br.status).toBe(422);
    expect(br.body.error.details.reason).toBe('invalid');
    expect(await previewInvitation(bogus)).toMatchObject({ state: 'invalid', business_name: null, role: null, destination: null });
    expect(await rolesOf(expired.invitee)).toEqual([]);
  });

  it('only the token hash is stored', async () => {
    const { token, inv } = await setup();
    const rows = await sql<{ token_hash: Buffer }>`select token_hash from app.invitation_by_token(${hashToken(token, 'invite')})`.execute(db());
    expect(rows.rows).toHaveLength(1);
    expect(Buffer.from(rows.rows[0]!.token_hash).toString('utf8')).not.toContain(token);
    expect(inv.invite_link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  });

  it('on a deployed build without messaging, only the inviting owner gets the link (no dev link, nothing sent)', async () => {
    const owner = await signup('Deployed owner');
    const biz = await createBusinessFor(owner);
    const invitee = await signup('Deployed invitee');
    process.env.APP_ENV = 'review'; process.env.DEV_OTP_ECHO = 'false';
    process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = 'review-sandbox-secret-0123456789'; resetEnvCache();
    const inv = await owner.call(invitations.POST, { params: { tenantSlug: biz.slug }, body: { identifier: invitee.identifier, role: 'finance' } });
    expect(inv.status).toBe(201);
    expect(inv.body.data.delivery).toBe('unavailable');
    expect(inv.body.data.dev_invite_link).toBeUndefined();
    const token = (inv.body.data.invite_link as string).split('/invite/')[1]!;
    expect((await invitee.call(accept.POST, { body: { token } })).body.data).toEqual({ tenant_slug: biz.slug, role: 'finance' });
  });
});
