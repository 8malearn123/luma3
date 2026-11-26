import { afterAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { analyzeNow, measureBusiness } from '@/loom';
import { addDays, localToday } from '@/server/domains/analytics/period';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as oppOne from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/route';
import * as convert from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/convert/route';
import * as initiatives from '@/app/api/v1/t/[tenantSlug]/loom/initiatives/route';
import * as executions from '@/app/api/v1/t/[tenantSlug]/loom/initiatives/[id]/executions/route';
import * as outcome from '@/app/api/v1/t/[tenantSlug]/loom/initiatives/[id]/outcome/route';
import * as results from '@/app/api/v1/t/[tenantSlug]/loom/results/route';
import { addMember } from '../helpers/platform';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { loomSalon } from '../helpers/loom-core';
import { addBooking, addCustomer } from '../helpers/marketing-data';

afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', 'like', 'loom.%').execute());
});

type Salon = Awaited<ReturnType<typeof loomSalon>>;
const DAY = 86_400_000;
const cards = async (s: Salon) => (await s.owner.call(opps.GET, { params: s.p })).body.data as any[];
const promo = (list: any[]) => list.find((o) => !['open_slots', 'staffing', 'restock', 'price_review'].includes(o.card.recommended_action.kind) && o.status === 'proposed');

async function converted(s: Salon, target: 'plan_action' | 'campaign_draft') {
  await analyzeNow(s.biz.tenantId);
  const o = promo(await cards(s));
  const cv = await s.owner.call(convert.POST, { params: { ...s.p, id: o.card.opportunity_id }, body: target === 'campaign_draft' ? { target, channel: 'in_app' } : { target } });
  expect(cv.status).toBe(201);
  const [init] = (await s.owner.call(initiatives.GET, { params: s.p })).body.data;
  return { o, ref: cv.body.data.result.ref_id as string, init };
}

/** Simulates a sent LUMA campaign: started 20 days ago, `target` delivered and `holdout` held-out customers. */
async function sentCampaign(s: Salon, campaignId: string, target: string[], holdout: string[]) {
  await withTenant(s.biz.tenantId, async (trx) => {
    await trx.updateTable('campaigns').set({ status: 'completed', started_at: new Date(Date.now() - 20 * DAY), finished_at: new Date(Date.now() - 20 * DAY) }).where('id', '=', campaignId).execute();
    const rows = [...target.map((c) => ({ c, kind: 'sent' })), ...holdout.map((c) => ({ c, kind: 'holdout' }))];
    await trx.insertInto('campaign_events').values(rows.map((r) => ({ tenant_id: s.biz.tenantId, campaign_id: campaignId, tenant_customer_id: r.c, kind: r.kind }))).execute();
  });
}

/** A completed booking created inside the attribution window (15 days ago). */
async function windowBooking(s: Salon, customer: string) {
  const id = await addBooking(s.biz, { customerId: customer, serviceId: s.s1, staffId: s.A, startsAt: new Date(Date.now() - 14 * DAY), price: 20000 });
  await withTenant(s.biz.tenantId, (trx) => trx.updateTable('bookings').set({ created_at: new Date(Date.now() - 15 * DAY) }).where('id', '=', id).execute());
}

describe('Measurement of non-partitionable initiatives (§10.3)', () => {
  it('a plan action is measured pre/post with control offerings as observational «إشارة محدودة لا علاقة سببية»', async () => {
    const s = await loomSalon({ consents: true });
    const { o, init } = await converted(s, 'plan_action');
    const today = localToday('Asia/Riyadh');
    const manager = await addMember(s.owner, s.biz.slug, 'manager');
    const body = { executed_from: addDays(today, -20), executed_to: addDays(today, -6), channel: 'in_app', actual_cost_minor: 5000, note: 'نُفذت يدويًا' };
    expect((await manager.call(executions.POST, { params: { ...s.p, id: init.id }, body })).status).toBe(403);
    expect((await s.owner.call(executions.POST, { params: { ...s.p, id: init.id }, body: { ...body, executed_to: addDays(today, -30) } })).status).toBe(422);
    const ex = await s.owner.call(executions.POST, { params: { ...s.p, id: init.id }, body });
    expect(ex.status).toBe(201);
    expect(ex.body.data).toMatchObject({ status: 'executing', window: { from: body.executed_from, to: body.executed_to } });

    const m = await measureBusiness(s.biz.tenantId);
    expect(m).toMatchObject({ completed: 1, measured: 1 });
    const r = (await s.owner.call(outcome.GET, { params: { ...s.p, id: init.id } })).body.data;
    expect(r.status).toBe('measured');
    expect(r.outcome).toMatchObject({ design: 'pre_post_with_control', quality: 'observational', causal: false, note: 'إشارة محدودة لا علاقة سببية', incremental: null });
    expect(r.outcome.limitations).toContain('إشارة محدودة لا علاقة سببية');
    const cb = r.outcome.primary.find((x: any) => x.key === 'completed_bookings');
    expect(cb.target.post).not.toBeNull();
    expect(cb.control).not.toBeNull();
    expect(r.outcome.guardrails.map((g: any) => g.key)).toEqual(['cancellations', 'refunds', 'occupancy_overload', 'rating']);
    expect(r.outcome.learnings.length).toBeGreaterThan(0);

    const detail = (await s.owner.call(oppOne.GET, { params: { ...s.p, id: o.card.opportunity_id } })).body.data;
    expect(detail.status).toBe('measured');
    expect(detail.ladder.map((x: any) => x.stage)).toEqual(['scheduled', 'executed', 'completed', 'measured']);
    // Idempotent job.
    expect(await measureBusiness(s.biz.tenantId)).toEqual({ executions: 0, completed: 0, measured: 0 });
    expect(await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.outcomes').select('id').execute())).toHaveLength(1);
    await expect(withTenant(s.biz.tenantId, (trx) => trx.updateTable('loom.outcomes').set({ causal: true }).execute())).rejects.toThrow();
    const home = (await s.owner.call(results.GET, { params: s.p })).body.data;
    expect(home.counts).toEqual({ measured: 1 });
    expect(home.latest[0]).toMatchObject({ id: init.id, measurement: { quality: 'observational', causal: false } });
  });

  it('an initiative whose window closed without a recorded execution is insufficient', async () => {
    const s = await loomSalon({ consents: true });
    const { init } = await converted(s, 'plan_action');
    const today = localToday('Asia/Riyadh');
    await withTenant(s.biz.tenantId, (trx) => trx.updateTable('loom.initiatives').set({ window_from: addDays(today, -10), window_to: addDays(today, -2) }).where('id', '=', init.id).execute());
    await measureBusiness(s.biz.tenantId);
    const r = (await s.owner.call(outcome.GET, { params: { ...s.p, id: init.id } })).body.data;
    expect(r.outcome.quality).toBe('insufficient');
    expect(r.outcome.limitations.join(' ')).toMatch(/لم يُسجَّل تنفيذ/);
  });
});

describe('Measurement of campaigns: holdout and MIN_GROUP 30', () => {
  it('fewer than 30 per group ⇒ insufficient (attributed only); the connector records the execution', async () => {
    const s = await loomSalon({ consents: true });
    const { ref, init } = await converted(s, 'campaign_draft');
    expect(init.measurement.design).toBe('holdout');
    await sentCampaign(s, ref, s.customers.slice(0, 4), s.customers.slice(4, 8));
    await windowBooking(s, s.customers[0]!);
    const m = await measureBusiness(s.biz.tenantId);
    expect(m).toMatchObject({ executions: 1, measured: 1 });
    const r = (await s.owner.call(outcome.GET, { params: { ...s.p, id: init.id } })).body.data.outcome;
    expect(r.quality).toBe('insufficient');
    expect(r.incremental).toMatchObject({ status: 'insufficient_sample', min_group: 30, members: { target: 4, holdout: 4 } });
    expect(r.attributed).toMatchObject({ members: 4, converters: 1, bookings: 1, net_minor: 20000 });
    expect(r.disclosure.attributed_is_not_incremental).toBe(true);
    const ex = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.initiative_executions').selectAll().execute());
    expect(ex).toEqual([expect.objectContaining({ source: 'connector', audience_size: 4, channel: 'in_app' })]);
    // A measured campaign feeds the change aggregator (learning).
    const sig = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.change_signals').select(['type', 'scope']).execute());
    expect(sig).toEqual([{ type: 'campaign_result', scope: `initiative:${init.id}` }]);
  });

  it('≥ 30 in both groups ⇒ experimental incremental estimate from the holdout', async () => {
    const s = await loomSalon({ consents: true });
    const { ref, init } = await converted(s, 'campaign_draft');
    const extra: string[] = [];
    for (let i = 0; i < 60; i++) extra.push(await addCustomer(s.biz, { name: `C${i}` }));
    const target = extra.slice(0, 30), holdout = extra.slice(30);
    await sentCampaign(s, ref, target, holdout);
    for (const c of target.slice(0, 9)) await windowBooking(s, c);
    for (const c of holdout.slice(0, 3)) await windowBooking(s, c);
    await measureBusiness(s.biz.tenantId);
    const r = (await s.owner.call(outcome.GET, { params: { ...s.p, id: init.id } })).body.data.outcome;
    expect(r.quality).toBe('experimental');
    expect(r.causal).toBe(true);
    expect(r.note).toBeNull();
    expect(r.incremental.status).toBe('estimated');
    expect(r.incremental.conversion_rate_lift).toBeCloseTo(0.2, 4);
    expect(r.incremental.net_minor).toBe(9 * 20000 - 3 * 20000);
    expect(r.attributed).toMatchObject({ members: 30, converters: 9 });
  });
});
