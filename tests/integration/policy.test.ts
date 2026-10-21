import { describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { runEvidencePurge, runPolicySweep } from '@/server/domains/policy/jobs';
import { createDecision } from '@/server/domains/policy/decisions';
import * as incidents from '@/app/api/v1/t/[tenantSlug]/policies/incidents/route';
import * as incidentOne from '@/app/api/v1/t/[tenantSlug]/policies/incidents/[id]/route';
import * as transition from '@/app/api/v1/t/[tenantSlug]/policies/incidents/[id]/transition/route';
import * as escalate from '@/app/api/v1/t/[tenantSlug]/policies/incidents/[id]/escalate/route';
import * as decisions from '@/app/api/v1/t/[tenantSlug]/policies/decisions/route';
import * as decisionEnd from '@/app/api/v1/t/[tenantSlug]/policies/decisions/[id]/end/route';
import * as rules from '@/app/api/v1/t/[tenantSlug]/policies/rules/route';
import * as tenantAppeals from '@/app/api/v1/t/[tenantSlug]/policies/appeals/route';
import * as tenantAppealResolve from '@/app/api/v1/t/[tenantSlug]/policies/appeals/[id]/resolve/route';
import * as auditTrail from '@/app/api/v1/t/[tenantSlug]/policies/audit/route';
import * as members from '@/app/api/v1/t/[tenantSlug]/members/[id]/route';
import * as pEscalations from '@/app/api/v1/platform/policies/escalations/route';
import * as pDecisions from '@/app/api/v1/platform/policies/decisions/route';
import * as pAppeals from '@/app/api/v1/platform/policies/appeals/route';
import * as pAppealResolve from '@/app/api/v1/platform/policies/appeals/[id]/resolve/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';
import * as accountPolicy from '@/app/api/v1/account/policy/route';
import * as accountAppeals from '@/app/api/v1/account/appeals/route';
import * as media from '@/app/api/v1/media/[id]/route';
import { storage } from '@/server/infra/storage';
import { createBusinessFor, signup } from '../helpers/factory';
import { addMember, expireStepUp, grantPlatformRole, hoursAgo, hoursFromNow, insertBooking, me, relationshipFor } from '../helpers/policy';

async function world() {
  const owner = await signup('Owner');
  const biz = await createBusinessFor(owner);
  const customer = await signup('Customer');
  const cu = await me(customer);
  const tcId = await relationshipFor(biz.tenantId, customer);
  const p = { tenantSlug: biz.slug };
  const noShow = (startsAt = hoursAgo(2)) => insertBooking(biz.tenantId, biz.branchId, { tenantCustomerId: tcId, customerUserId: cu.id, status: 'no_show', startsAt });
  const report = (bookingId: string, type = 'no_show') => owner.call(incidents.POST, { params: p, body: { booking_id: bookingId, type, description: 'Customer did not attend.' } });
  return { owner, biz, customer, cu, tcId, p, noShow, report };
}

describe('incidents', () => {
  it('no-show must reference a real no-show appointment after time + grace; duplicates rejected', async () => {
    const w = await world();
    const future = await insertBooking(w.biz.tenantId, w.biz.branchId, { tenantCustomerId: w.tcId, customerUserId: w.cu.id, status: 'no_show', startsAt: new Date(Date.now() + 5 * 60_000) });
    const early = await w.report(future.id);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('incident_too_early');
    // Within the grace period (default 15 min) is still too early.
    const justStarted = await w.noShow(new Date(Date.now() - 5 * 60_000));
    expect((await w.report(justStarted.id)).body.error.code).toBe('incident_too_early');
    const confirmedBooking = await insertBooking(w.biz.tenantId, w.biz.branchId, { tenantCustomerId: w.tcId, customerUserId: w.cu.id, status: 'confirmed', startsAt: hoursAgo(3) });
    expect((await w.report(confirmedBooking.id)).body.error.code).toBe('incident_booking_state');
    const noBooking = await w.owner.call(incidents.POST, { params: w.p, body: { tenant_customer_id: w.tcId, type: 'no_show', description: 'free text claim' } });
    expect(noBooking.body.error.code).toBe('incident_booking_required');

    const b = await w.noShow();
    const ok = await w.report(b.id);
    expect(ok.status).toBe(201);
    expect(ok.body.data.status).toBe('submitted');
    const dup = await w.report(b.id);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('incident_duplicate');
  });

  it('an incident on another business\'s booking is rejected as not found', async () => {
    const a = await world();
    const b = await world();
    const bBooking = await b.noShow();
    const r = await a.report(bBooking.id);
    expect(r.status).toBe(404);
    // And B's incident is invisible to A by id.
    const inc = await b.report(bBooking.id);
    expect((await a.owner.call(incidentOne.GET, { params: { ...a.p, id: inc.body.data.id } })).status).toBe(404);
  });

  it('review transitions need a note; confirm/reject/correct are recorded and audited; rules only suggest', async () => {
    const w = await world();
    await w.owner.call(rules.POST, { params: w.p, body: { key: 'noshow.test', criteria: { incident_type: 'no_show', min_confirmed: 1, window_days: 90 }, suggested_action: 'require_deposit' } });
    const b = await w.noShow();
    const inc = (await w.report(b.id)).body.data;
    const id = inc.id;
    const noNote = await w.owner.call(transition.POST, { params: { ...w.p, id }, body: { to: 'confirmed' } });
    expect(noNote.status).toBe(422);
    const conf = await w.owner.call(transition.POST, { params: { ...w.p, id }, body: { to: 'confirmed', note: 'Checked the calendar' } });
    expect(conf.status).toBe(200);
    expect(conf.body.data.status).toBe('confirmed');
    expect(conf.body.data.suggestions).toEqual([expect.objectContaining({ suggested_action: 'require_deposit', is_experimental: true })]);
    // A suggestion is not a decision.
    const ds = await w.owner.call(decisions.GET, { params: w.p });
    expect(ds.body.data.items).toHaveLength(0);

    const corr = await w.owner.call(transition.POST, { params: { ...w.p, id }, body: { to: 'corrected', note: 'Time was wrong', corrected_description: 'Customer did not attend (corrected).' } });
    expect(corr.body.data.status).toBe('corrected');
    const bad = await w.owner.call(transition.POST, { params: { ...w.p, id }, body: { to: 'under_review', note: 'reopen' } });
    expect(bad.status).toBe(409);
    const rej = await w.owner.call(transition.POST, { params: { ...w.p, id }, body: { to: 'rejected', note: 'Customer showed proof' } });
    expect(rej.body.data.status).toBe('rejected');
    const detail = await w.owner.call(incidentOne.GET, { params: { ...w.p, id } });
    expect(detail.body.data.reviews.map((r: any) => r.to_status)).toEqual(['confirmed', 'corrected', 'rejected']);
    const trail = await w.owner.call(auditTrail.GET, { params: w.p, query: { target_type: 'incident', target_id: id } });
    expect(trail.body.data.map((a: any) => a.action)).toEqual(['incident.submitted', 'incident.confirmed', 'incident.corrected', 'incident.rejected']);
    // incident_reviews is append-only.
    await expect(withTenant(w.biz.tenantId, (trx) => trx.updateTable('incident_reviews').set({ note: 'x' }).where('incident_id', '=', id).execute())).rejects.toThrow();
    // A rejected report frees the booking for a new, correct report.
    expect((await w.report(b.id)).status).toBe(201);
  });

  it('a reviewer cannot review her own report (owner excepted); submit-only members see only their own', async () => {
    const w = await world();
    const rec = await addMember(w.owner, w.biz.slug, 'manager', ['incidents.submit', 'incidents.review']);
    const b = await w.noShow();
    const inc = await rec.call(incidents.POST, { params: w.p, body: { booking_id: b.id, type: 'no_show', description: 'Did not attend' } });
    expect(inc.status).toBe(201);
    const self = await rec.call(transition.POST, { params: { ...w.p, id: inc.body.data.id }, body: { to: 'confirmed', note: 'looks right' } });
    expect(self.status).toBe(403);
    expect(self.body.error.details.reason).toBe('self_review');
    expect((await w.owner.call(transition.POST, { params: { ...w.p, id: inc.body.data.id }, body: { to: 'confirmed', note: 'looks right' } })).status).toBe(200);
    // A receptionist with only incidents.submit lists her own reports, and cannot review.
    const sub = await addMember(w.owner, w.biz.slug, 'receptionist', ['incidents.submit']);
    expect((await sub.call(incidents.GET, { params: w.p })).body.data.items).toHaveLength(0);
    expect((await sub.call(incidentOne.GET, { params: { ...w.p, id: inc.body.data.id } })).status).toBe(404);
    expect((await sub.call(transition.POST, { params: { ...w.p, id: inc.body.data.id }, body: { to: 'rejected', note: 'not mine' } })).status).toBe(403);
  });

  it('one incident report never changes platform-wide eligibility (escalation creates no decision)', async () => {
    const w = await world();
    const b = await w.noShow();
    const id = (await w.report(b.id)).body.data.id;
    // Escalating an unconfirmed report is refused.
    expect((await w.owner.call(escalate.POST, { params: { ...w.p, id }, body: { note: 'please review' } })).status).toBe(409);
    await w.owner.call(transition.POST, { params: { ...w.p, id }, body: { to: 'confirmed', note: 'Checked' } });
    const esc = await w.owner.call(escalate.POST, { params: { ...w.p, id }, body: { note: 'please review' } });
    expect(esc.status).toBe(200);
    expect(esc.body.data.escalation_status).toBe('pending');
    const platform = await withSystem('test', (trx) => trx.selectFrom('policy_decisions').select('id').where('scope', '=', 'platform').where('customer_user_id', '=', w.cu.id).execute());
    expect(platform).toHaveLength(0);
    const tenantDecisions = await withTenant(w.biz.tenantId, (trx) => trx.selectFrom('policy_decisions').select('id').where('tenant_customer_id', '=', w.tcId).execute());
    expect(tenantDecisions).toHaveLength(0);
  });
});

describe('decisions & authority', () => {
  it('evidence past its retention is purged unless an appeal is open or a decision relies on it', async () => {
    const w = await world();
    const ownerId = (await me(w.owner)).id;
    const mk = async () => {
      const b = await w.noShow();
      const id = (await w.report(b.id)).body.data.id as string;
      const asset = await withTenant(w.biz.tenantId, async (trx) => {
        const a = await trx.insertInto('assets').values({ tenant_id: w.biz.tenantId, kind: 'image', mime: 'image/png', bytes: 4, purpose: 'evidence', visibility: 'private', status: 'ready', storage_key: `test/ret-${id}.png`, uploaded_by: ownerId }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('incident_evidence').values({ tenant_id: w.biz.tenantId, incident_id: id, asset_id: a.id, added_by: ownerId, retain_until: hoursAgo(1) }).execute();
        return a.id;
      });
      return { id, asset };
    };
    const expired = await mk();
    const relied = await mk();
    await withTenant(w.biz.tenantId, (trx) => createDecision(trx, { scope: 'tenant', tenantId: w.biz.tenantId, tenantCustomerId: w.tcId, action: 'require_deposit', reason: 'Confirmed no-show backs this deposit requirement', reviewerId: ownerId, sourceIncidentId: relied.id, actor: { userId: ownerId, kind: 'user' }, silent: true }));
    await runEvidencePurge();
    const status = (id: string) => withTenant(w.biz.tenantId, (trx) => trx.selectFrom('assets').select('status').where('id', '=', id).executeTakeFirstOrThrow()).then((r) => r.status);
    expect(await status(expired.asset)).toBe('deleted');
    expect(await status(relied.asset)).toBe('ready');
  });

  it('platform reviewers see evidence only for escalated incidents', async () => {
    const w = await world();
    const b = await w.noShow();
    const id = (await w.report(b.id)).body.data.id;
    const ownerId = (await me(w.owner)).id;
    const asset = await withTenant(w.biz.tenantId, async (trx) => {
      const a = await trx.insertInto('assets').values({ tenant_id: w.biz.tenantId, kind: 'image', mime: 'image/png', bytes: 4, purpose: 'evidence', visibility: 'private', status: 'ready', storage_key: `test/evidence-${id}.png`, uploaded_by: ownerId }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('incident_evidence').values({ tenant_id: w.biz.tenantId, incident_id: id, asset_id: a.id, added_by: ownerId }).execute();
      return a.id;
    });
    await storage().put(`test/evidence-${id}.png`, Buffer.from('PNG!'), 'image/png');
    const reviewer = await signup('Evidence reviewer');
    await grantPlatformRole((await me(reviewer)).id, 'policy_reviewer');
    const stranger = await signup('Stranger');
    expect((await stranger.call(media.GET, { params: { id: asset } })).status).toBe(404);
    expect((await reviewer.call(media.GET, { params: { id: asset } })).status).toBe(404); // not escalated yet
    expect((await w.owner.call(media.GET, { params: { id: asset } })).status).toBe(200);
    await w.owner.call(transition.POST, { params: { ...w.p, id }, body: { to: 'confirmed', note: 'Checked' } });
    expect((await w.owner.call(escalate.POST, { params: { ...w.p, id }, body: { note: 'please review' } })).status).toBe(200);
    expect((await reviewer.call(media.GET, { params: { id: asset } })).status).toBe(200);
  });

  it('a salon owner cannot create platform decisions or grant herself reviewer powers', async () => {
    const w = await world();
    // Platform endpoints are invisible to tenant members.
    const r = await w.owner.call(pDecisions.POST, { body: { customer_user_id: w.cu.id, action: 'require_full_payment', reason: 'I want this everywhere' } });
    expect(r.status).toBe(404);
    expect((await w.owner.call(pEscalations.GET)).status).toBe(404);
    // The tenant decision endpoint rejects a platform scope or suspension.
    const scoped = await w.owner.call(decisions.POST, { params: w.p, body: { tenant_customer_id: w.tcId, action: 'require_full_payment', reason: 'repeat no-shows', scope: 'platform' } });
    expect(scoped.status).toBe(422);
    const suspend = await w.owner.call(decisions.POST, { params: w.p, body: { tenant_customer_id: w.tcId, action: 'suspend_account', reason: 'repeat no-shows' } });
    expect(suspend.status).toBe(422);
    // Granting platform capabilities through membership delegation is impossible.
    const mgr = await addMember(w.owner, w.biz.slug, 'manager');
    const mm = await withTenant(w.biz.tenantId, (trx) => trx.selectFrom('tenant_memberships').select('id').where('role', '=', 'manager').executeTakeFirstOrThrow());
    const g = await w.owner.call(members.PATCH, { params: { ...w.p, id: mm.id }, body: { granted_capabilities: ['platform.policy.review'] } });
    expect([403, 422]).toContain(g.status);
    expect((await mgr.call(pDecisions.GET)).status).toBe(404);
    // A manager without incidents.review cannot create tenant decisions either.
    expect((await mgr.call(decisions.POST, { params: w.p, body: { tenant_customer_id: w.tcId, action: 'require_deposit', reason: 'repeat no-shows' } })).status).toBe(403);
  });

  it('tenant decisions need step-up; revocation is audited', async () => {
    const w = await world();
    const ownerId = (await me(w.owner)).id;
    await expireStepUp(ownerId);
    const body = { tenant_customer_id: w.tcId, action: 'require_deposit', reason: 'two confirmed no-shows', is_experimental: true };
    const denied = await w.owner.call(decisions.POST, { params: w.p, body });
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('reauthentication_required');
    expect((await w.owner.call(reauth.POST, { body: { password: 'correct horse battery' } })).status).toBe(200);
    const ok = await w.owner.call(decisions.POST, { params: w.p, body });
    expect(ok.status).toBe(201);
    const end = await w.owner.call(decisionEnd.POST, { params: { ...w.p, id: ok.body.data.id }, body: { kind: 'revoke', reason: 'resolved with customer' } });
    expect(end.body.data.status).toBe('revoked');
    const trail = await w.owner.call(auditTrail.GET, { params: w.p, query: { target_type: 'policy_decision', target_id: ok.body.data.id } });
    expect(trail.body.data.map((a: any) => a.action)).toEqual(['policy_decision.created', 'policy_decision.revoked']);
  });

  it('platform decisions require a platform reviewer + step-up; suspension requires platform_owner', async () => {
    const w = await world();
    const reviewer = await signup('Reviewer');
    const rid = (await me(reviewer)).id;
    await grantPlatformRole(rid, 'policy_reviewer');
    const body = { customer_user_id: w.cu.id, action: 'require_full_payment', reason: 'Escalated confirmed incidents at several businesses', customer_explanation_en: 'Prepayment is required.' };
    await expireStepUp(rid);
    const noStep = await reviewer.call(pDecisions.POST, { body });
    expect(noStep.status).toBe(401);
    await reviewer.call(reauth.POST, { body: { password: 'correct horse battery' } });
    const ok = await reviewer.call(pDecisions.POST, { body });
    expect(ok.status).toBe(201);
    expect(ok.body.data.scope).toBe('platform');
    const sus = await reviewer.call(pDecisions.POST, { body: { ...body, action: 'suspend_account' } });
    expect(sus.status).toBe(403);
    const ownerP = await signup('Platform owner');
    await grantPlatformRole((await me(ownerP)).id, 'platform_owner');
    expect((await ownerP.call(pDecisions.POST, { body: { ...body, action: 'suspend_account' } })).status).toBe(201);
    // A support admin (other platform role) cannot review policy.
    const support = await signup('Support');
    await grantPlatformRole((await me(support)).id, 'support_admin');
    expect((await support.call(pDecisions.GET)).status).toBe(404);
  });

  it('platform reviewer resolves an escalation with a decision; the business never sees the platform reasoning', async () => {
    const w = await world();
    const b = await w.noShow();
    const id = (await w.report(b.id)).body.data.id;
    await w.owner.call(transition.POST, { params: { ...w.p, id }, body: { to: 'confirmed', note: 'Checked' } });
    const esc = await w.owner.call(escalate.POST, { params: { ...w.p, id }, body: { note: 'repeat issue' } });
    expect(esc.status, JSON.stringify(esc.body)).toBe(200);
    const reviewer = await signup('Reviewer');
    await grantPlatformRole((await me(reviewer)).id, 'policy_reviewer');
    const queue = await reviewer.call(pEscalations.GET);
    expect(queue.body.data.items.map((i: any) => i.id)).toContain(id);
    const d = await reviewer.call(pDecisions.POST, { body: { customer_user_id: w.cu.id, incident_id: id, action: 'require_deposit', reason: 'INTERNAL-PLATFORM-REASON' } });
    expect(d.status).toBe(201);
    const detail = await w.owner.call(incidentOne.GET, { params: { ...w.p, id } });
    expect(detail.body.data.escalation_status).toBe('decided');
    expect(JSON.stringify(detail.body)).not.toContain('INTERNAL-PLATFORM-REASON');
    expect(detail.body.data.reviews.at(-1)).toMatchObject({ reviewer_scope: 'platform', reviewer_name: null });
  });

  it('expiry job expires decisions; review_at is flagged once', async () => {
    const w = await world();
    const ownerId = (await me(w.owner)).id;
    const sys = { userId: null, kind: 'system' as const };
    const d1 = await withTenant(w.biz.tenantId, (trx) => createDecision(trx, { scope: 'tenant', tenantId: w.biz.tenantId, tenantCustomerId: w.tcId, action: 'require_deposit', reason: 'expiry test', reviewerId: ownerId, actor: sys, effectiveAt: hoursAgo(5), expiresAt: hoursAgo(1) }));
    const d2 = await withTenant(w.biz.tenantId, (trx) => createDecision(trx, { scope: 'tenant', tenantId: w.biz.tenantId, tenantCustomerId: w.tcId, action: 'manual_approval', reason: 'review test', reviewerId: ownerId, actor: sys, effectiveAt: hoursAgo(5), reviewAt: hoursAgo(1), expiresAt: hoursFromNow(100) }));
    const r = await runPolicySweep();
    expect(r.expired).toBeGreaterThanOrEqual(1);
    const rows = await withTenant(w.biz.tenantId, (trx) => trx.selectFrom('policy_decisions').select(['id', 'status', 'review_flagged_at']).where('id', 'in', [d1.id, d2.id]).execute());
    expect(rows.find((x) => x.id === d1.id)!.status).toBe('expired');
    expect(rows.find((x) => x.id === d2.id)!.status).toBe('active');
    expect(rows.find((x) => x.id === d2.id)!.review_flagged_at).not.toBeNull();
    const notif = await withSystem('test', (trx) => trx.selectFrom('notifications').select('id').where('user_id', '=', ownerId).where('kind', '=', 'policy.review_due').execute());
    expect(notif).toHaveLength(1);
    const again = await runPolicySweep();
    const due = await withTenant(w.biz.tenantId, (trx) => trx.selectFrom('policy_decisions').select('review_flagged_at').where('id', '=', d2.id).executeTakeFirstOrThrow());
    expect(due.review_flagged_at!.getTime()).toBe(rows.find((x) => x.id === d2.id)!.review_flagged_at!.getTime());
    expect(again.flagged).toBe(0);
    const due2 = await w.owner.call(decisions.GET, { params: w.p, query: { review_due: '1' } });
    expect(due2.body.data.items.map((i: any) => i.id)).toEqual([d2.id]);
  });
});

describe('appeals', () => {
  it('customer appeals only her own items; tenant reviewer accepts and the decision is revoked', async () => {
    const w = await world();
    const other = await signup('Other customer');
    const b = await w.noShow();
    const incId = (await w.report(b.id)).body.data.id;
    await w.owner.call(transition.POST, { params: { ...w.p, id: incId }, body: { to: 'confirmed', note: 'Checked by Sara at reception' } });
    const dec = await w.owner.call(decisions.POST, { params: w.p, body: { tenant_customer_id: w.tcId, action: 'require_full_payment', reason: 'internal: staff Sara reported', evidence_refs: [{ type: 'incident', id: incId }], customer_explanation_en: 'Prepayment needed for now.' } });
    expect(dec.status).toBe(201);

    const mine = await w.customer.call(accountPolicy.GET);
    expect(mine.body.data.decisions).toEqual([expect.objectContaining({ id: dec.body.data.id, action: 'require_full_payment', customer_explanation_en: 'Prepayment needed for now.', can_appeal: true })]);
    expect(mine.body.data.incidents).toEqual([expect.objectContaining({ id: incId, type: 'no_show', status: 'confirmed' })]);
    const raw = JSON.stringify(mine.body);
    expect(raw).not.toContain('internal: staff Sara');
    expect(raw).not.toContain('Checked by Sara');
    expect(raw).not.toContain('Customer did not attend');

    // Another customer cannot appeal (or even see) it.
    expect((await other.call(accountAppeals.POST, { body: { decision_id: dec.body.data.id, message: 'This is not about me at all' } })).status).toBe(404);
    expect((await other.call(accountPolicy.GET)).body.data.decisions).toHaveLength(0);

    const ap = await w.customer.call(accountAppeals.POST, { body: { decision_id: dec.body.data.id, message: 'I was in hospital that day, here is why.' } });
    expect(ap.status).toBe(201);
    expect((await w.customer.call(accountAppeals.POST, { body: { decision_id: dec.body.data.id, message: 'Second appeal on the same thing' } })).status).toBe(409);

    const inbox = await w.owner.call(tenantAppeals.GET, { params: w.p });
    expect(inbox.body.data.items).toEqual([expect.objectContaining({ id: ap.body.data.id, customer_name: 'Customer', decision_action: 'require_full_payment' })]);
    const res = await w.owner.call(tenantAppealResolve.POST, { params: { ...w.p, id: ap.body.data.id }, body: { outcome: 'accepted', resolution_note: 'Thank you, the restriction is removed.' } });
    expect(res.status).toBe(200);
    expect(res.body.data.effects.revoked_decision_id).toBe(dec.body.data.id);

    const list = await w.customer.call(accountAppeals.GET);
    expect(list.body.data[0]).toMatchObject({ status: 'accepted', resolution_note: 'Thank you, the restriction is removed.' });
    expect(list.body.data[0]).not.toHaveProperty('reviewer_id');
    const after = await w.customer.call(accountPolicy.GET);
    expect(after.body.data.decisions[0].status).toBe('revoked');
  });

  it('accepted appeal can correct a decision to a milder action; incident appeal overturns the incident', async () => {
    const w = await world();
    const dec = await w.owner.call(decisions.POST, { params: w.p, body: { tenant_customer_id: w.tcId, action: 'require_full_payment', reason: 'late cancellations' } });
    const ap = await w.customer.call(accountAppeals.POST, { body: { decision_id: dec.body.data.id, message: 'Please reconsider the full payment' } });
    const res = await w.owner.call(tenantAppealResolve.POST, { params: { ...w.p, id: ap.body.data.id }, body: { outcome: 'accepted', resolution_note: 'Reduced to a deposit.', corrected_action: 'require_deposit' } });
    expect(res.body.data.effects.corrected_decision_id).toBeTruthy();
    const active = await w.owner.call(decisions.GET, { params: w.p });
    expect(active.body.data.items).toEqual([expect.objectContaining({ action: 'require_deposit', supersedes_id: dec.body.data.id })]);

    const b = await w.noShow();
    const incId = (await w.report(b.id)).body.data.id;
    // Not yet confirmed → not appealable (and not visible to her).
    expect((await w.customer.call(accountAppeals.POST, { body: { incident_id: incId, message: 'I was there on time!' } })).status).toBe(404);
    await w.owner.call(transition.POST, { params: { ...w.p, id: incId }, body: { to: 'confirmed', note: 'okay' } });
    const ia = await w.customer.call(accountAppeals.POST, { body: { incident_id: incId, message: 'I was there on time!' } });
    expect(ia.status).toBe(201);
    await w.owner.call(tenantAppealResolve.POST, { params: { ...w.p, id: ia.body.data.id }, body: { outcome: 'accepted', resolution_note: 'Our mistake, sorry.' } });
    const inc = await w.owner.call(incidentOne.GET, { params: { ...w.p, id: incId } });
    expect(inc.body.data.status).toBe('rejected');
  });

  it('platform appeals go to platform reviewers, not the business', async () => {
    const w = await world();
    const reviewer = await signup('Reviewer');
    await grantPlatformRole((await me(reviewer)).id, 'policy_reviewer');
    const d = await reviewer.call(pDecisions.POST, { body: { customer_user_id: w.cu.id, action: 'manual_approval', reason: 'platform level review' } });
    const ap = await w.customer.call(accountAppeals.POST, { body: { decision_id: d.body.data.id, message: 'Please review my LUMA restriction' } });
    expect(ap.body.data.review_scope).toBe('platform');
    expect((await w.owner.call(tenantAppeals.GET, { params: w.p })).body.data.items).toHaveLength(0);
    expect((await w.owner.call(tenantAppealResolve.POST, { params: { ...w.p, id: ap.body.data.id }, body: { outcome: 'accepted', resolution_note: 'nope' } })).status).toBe(404);
    const q = await reviewer.call(pAppeals.GET);
    expect(q.body.data.items.map((a: any) => a.id)).toContain(ap.body.data.id);
    const r = await reviewer.call(pAppealResolve.POST, { params: { id: ap.body.data.id }, body: { outcome: 'rejected', resolution_note: 'The restriction remains for 30 days.' } });
    expect(r.body.data.status).toBe('rejected');
  });
});
