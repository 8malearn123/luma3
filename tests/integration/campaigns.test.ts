import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import { addBooking, addConsent, addCustomer, addService, addStaff } from '../helpers/marketing-data';
import * as segments from '@/app/api/v1/t/[tenantSlug]/marketing/segments/route';
import * as preview from '@/app/api/v1/t/[tenantSlug]/marketing/segments/preview/route';
import * as campaigns from '@/app/api/v1/t/[tenantSlug]/marketing/campaigns/route';
import * as approve from '@/app/api/v1/t/[tenantSlug]/marketing/campaigns/[id]/approve/route';
import * as scheduleRoute from '@/app/api/v1/t/[tenantSlug]/marketing/campaigns/[id]/schedule/route';
import * as cancel from '@/app/api/v1/t/[tenantSlug]/marketing/campaigns/[id]/cancel/route';
import * as results from '@/app/api/v1/t/[tenantSlug]/marketing/campaigns/[id]/results/route';
import * as campaignOne from '@/app/api/v1/t/[tenantSlug]/marketing/campaigns/[id]/route';
import * as suppression from '@/app/api/v1/t/[tenantSlug]/marketing/suppression/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import { withTenant } from '@/server/db/client';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { resetEnvCache } from '@/server/env';
import { quietHoursEnd, runCampaignSend } from '@/server/domains/marketing/campaigns';

afterEach(() => { process.env.DEV_OTP_ECHO = 'true'; resetEnvCache(); });
afterAll(() => cancelLeftoverMarketingJobs());

const NOON_RIYADH = new Date('2026-10-21T09:00:00Z'); // 12:00 local
const NIGHT_RIYADH = new Date('2026-10-21T20:00:00Z'); // 23:00 local
const DAY = 86_400_000;

async function setup() {
  const owner = await signup('Owner');
  const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
  const p = { tenantSlug: biz.slug };
  const tag = 'aud';
  const ok = await addCustomer(biz, { name: 'Consenting', email: 'ok@example.test', tags: [tag] });
  const none = await addCustomer(biz, { name: 'No consent', email: 'none@example.test', tags: [tag] });
  const optedOut = await addCustomer(biz, { name: 'Opted out', email: 'out@example.test', tags: [tag] });
  const suppressed = await addCustomer(biz, { name: 'Suppressed', email: 'Bounce@Example.test', tags: [tag] });
  const capped = await addCustomer(biz, { name: 'Capped', email: 'cap@example.test', tags: [tag, 'vip'] });
  const smsOnly = await addCustomer(biz, { name: 'SMS consent only', email: 'sms@example.test', tags: [tag] });
  for (const c of [ok, optedOut, suppressed, capped]) await addConsent(biz, c, 'email', true, new Date(Date.now() - 10 * DAY));
  await addConsent(biz, optedOut, 'email', false, new Date(Date.now() - DAY)); // latest row wins
  await addConsent(biz, smsOnly, 'sms', true); // consent is channel-specific
  return { owner, biz, p, tag, ids: { ok, none, optedOut, suppressed, capped, smsOnly } };
}

async function draft(owner: any, p: any, segmentId: string, over: Record<string, unknown> = {}) {
  const r = await owner.call(campaigns.POST, { params: p, body: { name: 'Autumn reminder', channel: 'email', segment_id: segmentId, content: { subject: 'Hello', body: 'Book your next visit' }, holdout_bp: 0, ...over } });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

describe('segments', () => {
  it('previews counts from allowlisted conditions and hides names without customers.view', async () => {
    const { owner, biz, p, tag } = await setup();
    const def = { conditions: [{ type: 'tag', tag }, { type: 'has_consent', channel: 'email' }] };
    const r = await owner.call(preview.POST, { params: p, body: { definition: def } });
    expect(r.status).toBe(200);
    expect(r.body.data.count).toBe(3); // ok, suppressed, capped (opted-out's latest consent is a refusal)
    expect(r.body.data.sample).toHaveLength(3); // owner holds customers.view
    // SQL in a parameter is just a value.
    const inj = await owner.call(preview.POST, { params: p, body: { definition: { conditions: [{ type: 'tag', tag: "x' or 1=1 --" }] } } });
    expect(inj.body.data.count).toBe(0);
    expect((await owner.call(preview.POST, { params: p, body: { definition: { conditions: [{ type: 'raw_sql', sql: 'select 1' }] } } })).status).toBe(422);
    // A finance member (no customers.view) gets counts only.
    const fin = await signup('Finance');
    const inv = await owner.call(invitations.POST, { params: p, body: { identifier: fin.identifier, role: 'manager' } });
    await fin.call(accept.POST, { body: { token: inv.body.data.dev_invite_link.split('/invite/')[1] } });
    await withTenant(biz.tenantId, (trx) => trx.updateTable('tenant_memberships').set({ revoked_capabilities: ['customers.view'] }).where('role', '=', 'manager').execute());
    const mr = await fin.call(preview.POST, { params: p, body: { definition: def } });
    expect(mr.status).toBe(200);
    expect(mr.body.data.count).toBe(3);
    expect(mr.body.data.sample).toBeUndefined();
  });
});

describe('campaign sending rules', () => {
  it('requires approval, enforces consent, opt-out, suppression and frequency caps, and labels simulations', async () => {
    const { owner, biz, p, tag, ids } = await setup();
    const segAll = (await owner.call(segments.POST, { params: p, body: { name: 'All', definition: { conditions: [{ type: 'tag', tag }] } } })).body.data.id;
    const segVip = (await owner.call(segments.POST, { params: p, body: { name: 'VIP', definition: { conditions: [{ type: 'tag', tag: 'vip' }] } } })).body.data.id;

    // An earlier campaign reached the capped customer two days ago.
    const first = await draft(owner, p, segVip);
    expect((await owner.call(approve.POST, { params: { ...p, id: first } })).status).toBe(200);
    expect((await owner.call(scheduleRoute.POST, { params: { ...p, id: first }, body: {} })).status).toBe(200);
    expect((await runCampaignSend(biz.tenantId, first, { now: new Date(NOON_RIYADH.getTime() - 2 * DAY) })).status).toBe('sent');

    const id = await draft(owner, p, segAll);
    // No send without approval.
    const early = await owner.call(scheduleRoute.POST, { params: { ...p, id }, body: {} });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('approval_required');
    // Permission: a receptionist cannot approve.
    const recep = await signup('Reception');
    const inv = await owner.call(invitations.POST, { params: p, body: { identifier: recep.identifier, role: 'receptionist' } });
    await recep.call(accept.POST, { body: { token: inv.body.data.dev_invite_link.split('/invite/')[1] } });
    expect((await recep.call(approve.POST, { params: { ...p, id } })).status).toBe(403);

    await owner.call(suppression.POST, { params: p, body: { channel: 'email', destination: 'bounce@example.test' } });
    expect((await owner.call(approve.POST, { params: { ...p, id } })).status).toBe(200);
    expect((await owner.call(campaignOne.PATCH, { params: { ...p, id }, body: { name: 'Changed after approval' } })).status).toBe(409);
    expect((await owner.call(scheduleRoute.POST, { params: { ...p, id }, body: {} })).status).toBe(200);

    // Quiet hours (tenant-local) defer the send.
    const night = await runCampaignSend(biz.tenantId, id, { now: NIGHT_RIYADH });
    expect(night.status).toBe('deferred_quiet_hours');
    expect(quietHoursEnd(NIGHT_RIYADH, 'Asia/Riyadh', { from: '21:00', to: '09:00' })!.toISOString()).toBe('2026-10-22T06:00:00.000Z');

    const out = await runCampaignSend(biz.tenantId, id, { now: NOON_RIYADH });
    expect(out).toMatchObject({ status: 'sent', audience: 6, simulated: 1, delivered: 0 });
    expect(out.suppressed).toEqual({ no_consent: 2, opted_out: 1, suppression_list: 1, frequency_cap: 1 });
    const ev = await withTenant(biz.tenantId, (trx) => trx.selectFrom('campaign_events').select(['tenant_customer_id', 'kind', 'data']).where('campaign_id', '=', id).execute());
    const outcome = (c: string) => ev.filter((e) => e.tenant_customer_id === c && e.kind !== 'targeted').map((e) => e.kind);
    expect(outcome(ids.ok)).toEqual(['simulated']);
    expect(outcome(ids.smsOnly)).toEqual(['suppressed']);
    expect(outcome(ids.capped)).toEqual(['suppressed']);
    const outbox = await withTenant(biz.tenantId, (trx) => trx.selectFrom('dev_message_outbox').select(['destination', 'subject']).where('destination', '=', 'ok@example.test').execute());
    expect(outbox[0]!.subject).toMatch(/^\[SIMULATED CAMPAIGN L-/);
    // Running the job again is a no-op.
    expect((await runCampaignSend(biz.tenantId, id, { now: NOON_RIYADH })).status).toBe('skipped');
    const audit = await withTenant(biz.tenantId, (trx) => trx.selectFrom('audit_logs').select('action').where('target_id', '=', id).execute());
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['marketing.campaign_approved', 'marketing.campaign_scheduled', 'marketing.campaign_sent']));
  });

  it('cannot start on a disconnected channel; cancelled schedules never send', async () => {
    const { owner, biz, p, tag } = await setup();
    const seg = (await owner.call(segments.POST, { params: p, body: { name: 'All', definition: { conditions: [{ type: 'tag', tag }] } } })).body.data.id;
    const id = await draft(owner, p, seg);
    await owner.call(approve.POST, { params: { ...p, id } });
    process.env.DEV_OTP_ECHO = 'false';
    resetEnvCache();
    const r = await owner.call(scheduleRoute.POST, { params: { ...p, id }, body: {} });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('channel_disconnected');
    process.env.DEV_OTP_ECHO = 'true';
    resetEnvCache();
    expect((await owner.call(scheduleRoute.POST, { params: { ...p, id }, body: {} })).status).toBe(200);
    // Provider disappears between scheduling and sending → blocked honestly.
    process.env.DEV_OTP_ECHO = 'false';
    resetEnvCache();
    expect(await runCampaignSend(biz.tenantId, id, { now: NOON_RIYADH })).toMatchObject({ status: 'failed', reason: 'channel_disconnected' });

    process.env.DEV_OTP_ECHO = 'true';
    resetEnvCache();
    const id2 = await draft(owner, p, seg);
    await owner.call(approve.POST, { params: { ...p, id: id2 } });
    await owner.call(scheduleRoute.POST, { params: { ...p, id: id2 }, body: { scheduled_at: new Date(Date.now() + DAY).toISOString() } });
    expect((await owner.call(cancel.POST, { params: { ...p, id: id2 } })).body.data.status).toBe('cancelled');
    expect((await runCampaignSend(biz.tenantId, id2, { now: NOON_RIYADH })).status).toBe('skipped');
    const sent = await withTenant(biz.tenantId, (trx) => trx.selectFrom('campaign_events').select('id').where('campaign_id', '=', id2).execute());
    expect(sent).toHaveLength(0);
  });

  it('in-app reaches only customers with a LUMA account and push consent', async () => {
    const { owner, biz, p } = await setup();
    const withAccount = await signup('Customer with account');
    const userRow = await withTenant(biz.tenantId, (trx) => trx.selectFrom('users').select('id').where('email', '=', withAccount.identifier).executeTakeFirstOrThrow());
    const c1 = await addCustomer(biz, { name: 'App user', userId: userRow.id, tags: ['app'] });
    const c2 = await addCustomer(biz, { name: 'No account', tags: ['app'] });
    await addConsent(biz, c1, 'push', true);
    await addConsent(biz, c2, 'push', true);
    const seg = (await owner.call(segments.POST, { params: p, body: { name: 'App', definition: { conditions: [{ type: 'tag', tag: 'app' }] } } })).body.data.id;
    const id = await draft(owner, p, seg, { channel: 'in_app', content: { body: 'New openings this week', deep_link: `/s/${biz.slug}` } });
    await owner.call(approve.POST, { params: { ...p, id } });
    await owner.call(scheduleRoute.POST, { params: { ...p, id }, body: {} });
    const out = await runCampaignSend(biz.tenantId, id, { now: NOON_RIYADH });
    expect(out).toMatchObject({ status: 'sent', delivered: 1, suppressed: { no_luma_account: 1 } });
    const n = await withTenant(biz.tenantId, (trx) => trx.selectFrom('notifications').select(['user_id', 'target_path']).where('kind', '=', 'marketing.campaign').execute());
    expect(n).toHaveLength(1);
    expect(n[0]!.user_id).toBe(userRow.id);
    expect(n[0]!.target_path).toContain('utm_campaign=L-');
  });
});

describe('campaign results', () => {
  it('counts completed bookings net of refunds once, separates attributed from incremental and discloses the window', async () => {
    const { owner, biz, p, tag, ids } = await setup();
    const seg = (await owner.call(segments.POST, { params: p, body: { name: 'All', definition: { conditions: [{ type: 'tag', tag }] } } })).body.data.id;
    const id = await draft(owner, p, seg, { attribution_window_days: 14 });
    await owner.call(approve.POST, { params: { ...p, id } });
    await owner.call(scheduleRoute.POST, { params: { ...p, id }, body: {} });
    const d2 = new Date(Date.now() - 2 * DAY);
    const sentAt = new Date(Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate(), 9, 0)); // 12:00 Riyadh, outside quiet hours
    expect((await runCampaignSend(biz.tenantId, id, { now: sentAt })).status).toBe('sent');
    const staff = await addStaff(biz);
    const svc = await addService(biz);
    await addBooking(biz, { customerId: ids.ok, serviceId: svc, staffId: staff, startsAt: new Date(Date.now() - DAY), price: 20000, refunded: 5000, status: 'completed' });
    await addBooking(biz, { customerId: ids.ok, serviceId: svc, staffId: staff, startsAt: new Date(Date.now() + DAY), price: 9000, status: 'cancelled' });
    const r1 = await owner.call(results.GET, { params: { ...p, id } });
    expect(r1.status).toBe(200);
    const d = r1.body.data;
    expect(d.results.attributed_net_minor).toBe(15000);
    expect(d.results.delivered).toMatchObject({ members: 3, converters: 1, bookings: 1 }); // 3 consenting recipients, one converted
    expect(d.results.incremental.status).toBe('insufficient_sample');
    expect(d.disclosure).toMatchObject({ attribution_window_days: 14, attributed_is_not_incremental: true, simulated_only: true, excludes: ['cancelled', 'no_show'] });
    await owner.call(results.GET, { params: { ...p, id } });
    const conv = await withTenant(biz.tenantId, (trx) => trx.selectFrom('campaign_events').select('id').where('campaign_id', '=', id).where('kind', '=', 'converted').execute());
    expect(conv).toHaveLength(1);
  });
});
