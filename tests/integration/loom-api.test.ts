import { afterAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { analyzeNow } from '@/loom';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as oppOne from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/route';
import * as decision from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/decision/route';
import * as convert from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/convert/route';
import * as analyses from '@/app/api/v1/t/[tenantSlug]/loom/analyses/route';
import * as setup from '@/app/api/v1/t/[tenantSlug]/loom/setup/route';
import { addMember } from '../helpers/platform';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { approvedLeave, loomSalon } from '../helpers/loom-core';

afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', '=', 'loom.analysis').execute());
});

const cards = async (s: Awaited<ReturnType<typeof loomSalon>>, query: Record<string, string> = {}) => (await s.owner.call(opps.GET, { params: s.p, query })).body.data as any[];

describe('Loom opportunity decisions (§10.1)', () => {
  it('approve / study / defer / dismiss with categorised reasons; invalid transitions are refused', async () => {
    const s = await loomSalon({ s2Cost: null });
    await analyzeNow(s.biz.tenantId);
    const [a, b, c] = await cards(s);
    const id = (x: any) => ({ ...s.p, id: x.card.opportunity_id });
    expect((await s.owner.call(decision.POST, { params: id(a), body: { action: 'defer' } })).status).toBe(422);
    expect((await s.owner.call(decision.POST, { params: id(a), body: { action: 'dismiss', reason: 'other' } })).status).toBe(422);
    expect((await s.owner.call(decision.POST, { params: id(a), body: { action: 'dismiss', reason: 'nope' } })).status).toBe(422);
    const st = await s.owner.call(decision.POST, { params: id(a), body: { action: 'study' } });
    expect(st.body.data.status).toBe('studying');
    const ap = await s.owner.call(decision.POST, { params: id(a), body: { action: 'approve', note: 'yes' } });
    expect(ap.body.data.status).toBe('accepted');
    expect((await s.owner.call(decision.POST, { params: id(a), body: { action: 'study' } })).status).toBe(409);
    const df = await s.owner.call(decision.POST, { params: id(b), body: { action: 'defer', reason: 'timing', until: '2099-01-01' } });
    expect(df.body.data).toMatchObject({ status: 'deferred', decision: { reason: 'timing', deferred_until: '2099-01-01' } });
    const dm = await s.owner.call(decision.POST, { params: id(c), body: { action: 'dismiss', reason: 'not_valuable' } });
    expect(dm.body.data.status).toBe('dismissed');
    expect(dm.body.data.events.at(-1)).toMatchObject({ event: 'decided', reason: 'not_valuable', counts_as_idea_failure: true });
    // Re-analysis keeps decisions: dismissed (idea) stays dismissed, deferred stays deferred until its date.
    await analyzeNow(s.biz.tenantId);
    const after = await cards(s, { open: '0' });
    expect(after.find((x) => x.card.opportunity_id === c.card.opportunity_id).status).toBe('dismissed');
    expect(after.find((x) => x.card.opportunity_id === b.card.opportunity_id).status).toBe('deferred');
    expect(after.find((x) => x.card.opportunity_id === a.card.opportunity_id).status).toBe('accepted');
    const audit = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('audit_logs').select('action').where('action', '=', 'loom.opportunity_decided').execute());
    expect(audit.length).toBe(4);
  });

  it('T13: dismissed for capacity_staffing is not an idea failure and comes back once capacity exists', async () => {
    const s = await loomSalon({ s2Staff: 'B' });
    const leave = await approvedLeave(s.biz, s.B!);
    await analyzeNow(s.biz.tenantId);
    const blocked = (await cards(s)).find((o) => o.detector_id === 'high_satisfaction_low_demand');
    expect(blocked.card.category).toBe('capacity_prerequisite');
    expect(blocked.card.capacity_check.status).toBe('blocked');
    expect(blocked.bucket).toBe('blocked');
    const dm = await s.owner.call(decision.POST, { params: { ...s.p, id: blocked.card.opportunity_id }, body: { action: 'dismiss', reason: 'capacity_staffing' } });
    expect(dm.body.data.events.at(-1)).toMatchObject({ reason: 'capacity_staffing', counts_as_idea_failure: false });
    // Still blocked: stays dismissed.
    await analyzeNow(s.biz.tenantId);
    expect((await cards(s, { open: '0' })).find((o) => o.card.opportunity_id === blocked.card.opportunity_id).status).toBe('dismissed');
    // The leave is withdrawn: the specialist has free time again ⇒ the opportunity is re-offered.
    await withTenant(s.biz.tenantId, (trx) => trx.updateTable('leave_requests').set({ status: 'cancelled' }).where('id', '=', leave).execute());
    await analyzeNow(s.biz.tenantId);
    const back = (await s.owner.call(oppOne.GET, { params: { ...s.p, id: blocked.card.opportunity_id } })).body.data;
    expect(back.status).toBe('proposed');
    expect(back.card.category).toBe('high_satisfaction_low_demand');
    expect(back.card.capacity_check.status).toBe('ok');
    expect(back.events.at(-1)).toMatchObject({ event: 'reopened', reason: 'capacity_available' });
  });
});

describe('Loom conversions through LUMA’s ActionPort', () => {
  it('plan_action appends a plan version; campaign_draft creates a draft; price_proposal only for price reviews', async () => {
    const s = await loomSalon({ consents: true });
    await analyzeNow(s.biz.tenantId);
    const list = await cards(s);
    const promo = list.find((o) => !['open_slots', 'staffing', 'restock', 'price_review'].includes(o.card.recommended_action.kind));
    const id = { ...s.p, id: promo.card.opportunity_id };
    const p1 = await s.owner.call(convert.POST, { params: id, body: { target: 'plan_action' } });
    expect(p1.status).toBe(201);
    expect(p1.body.data.opportunity.status).toBe('converted');
    const plan = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('plan_versions').select(['plan_id', 'content', 'source']).where('plan_id', '=', p1.body.data.result.ref_id).execute());
    expect(plan).toHaveLength(1);
    expect((plan[0]!.content as any).activities[0].title).toBe(promo.card.title);
    const p2 = await s.owner.call(convert.POST, { params: id, body: { target: 'plan_action' } });
    expect(p2.body.data.result.status).toBe('version_2');

    const c = await s.owner.call(convert.POST, { params: id, body: { target: 'campaign_draft', channel: 'in_app' } });
    expect(c.status).toBe(201);
    const camp = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('campaigns').select(['status', 'channel']).where('id', '=', c.body.data.result.ref_id).executeTakeFirstOrThrow());
    expect(camp).toEqual({ status: 'draft', channel: 'in_app' });
    expect((await s.owner.call(convert.POST, { params: id, body: { target: 'price_proposal', proposed_price_minor: 25000 } })).status).toBe(422);
    const events = (await s.owner.call(oppOne.GET, { params: id })).body.data.events.filter((e: any) => e.event === 'converted');
    expect(events).toHaveLength(3);
  });

  it('price_proposal from a margin-leak review creates a catalog proposal (never a direct price change)', async () => {
    const s = await loomSalon();
    await withTenant(s.biz.tenantId, (trx) => trx.updateTable('services').set({ cost_minor: 18000 }).where('id', '=', s.s1).execute());
    await analyzeNow(s.biz.tenantId);
    const leak = (await cards(s)).find((o) => o.card.category === 'margin_leak');
    expect(leak.card.recommended_action.kind).toBe('price_review');
    expect(leak.details.recommended_action.direction ?? 'increase_review').toBe('increase_review');
    const r = await s.owner.call(convert.POST, { params: { ...s.p, id: leak.card.opportunity_id }, body: { target: 'price_proposal', proposed_price_minor: 23000 } });
    expect(r.status).toBe(201);
    const svc = await withTenant(s.biz.tenantId, async (trx) => ({
      price: (await trx.selectFrom('services').select('price_minor').where('id', '=', s.s1).executeTakeFirstOrThrow()).price_minor,
      proposal: await trx.selectFrom('service_price_proposals').select(['status', 'proposed_price_minor', 'source']).where('id', '=', r.body.data.result.ref_id).executeTakeFirstOrThrow(),
    }));
    expect(svc.price).toBe(20000);
    expect(svc.proposal).toEqual({ status: 'proposed', proposed_price_minor: 23000, source: 'recommendation' });
  });
});

describe('Loom permissions (capability mapping)', () => {
  it('loom.view → marketing.view; loom.manage → marketing.manage; staff without marketing see nothing', async () => {
    const s = await loomSalon();
    await analyzeNow(s.biz.tenantId);
    const [first] = await cards(s);
    const manager = await addMember(s.owner, s.biz.slug, 'manager');
    const receptionist = await addMember(s.owner, s.biz.slug, 'receptionist');
    expect((await manager.call(opps.GET, { params: s.p })).status).toBe(200);
    expect((await manager.call(decision.POST, { params: { ...s.p, id: first.card.opportunity_id }, body: { action: 'approve' } })).status).toBe(403);
    expect((await manager.call(analyses.POST, { params: s.p, body: {} })).status).toBe(403);
    expect((await receptionist.call(opps.GET, { params: s.p })).status).toBe(403);
    expect((await receptionist.call(setup.GET, { params: s.p })).status).toBe(403);
  });
});

describe('T6 end to end: no_discounts', () => {
  it('after confirming "no discounts" no opportunity carries a discount intervention', async () => {
    const s = await loomSalon();
    const r = await s.owner.call(setup.PUT, { params: s.p, body: { discount_policy: { no_discounts: true, max_discount_bp: 0 } } });
    expect(r.status).toBe(200);
    expect(r.body.data.preferences).toMatchObject({ no_discounts: true, max_discount_bp: 0 });
    await analyzeNow(s.biz.tenantId);
    for (const o of await cards(s)) {
      expect(o.card.recommended_action.kind).not.toBe('limited_discount');
      expect(o.card.alternatives_considered.map((a: any) => a.kind)).not.toContain('limited_discount');
    }
  });
});
