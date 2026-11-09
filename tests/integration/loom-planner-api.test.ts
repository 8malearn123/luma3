import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { analyzeNow, generatePlanNow, retrieveKnowledge } from '@/loom';
import { setAiProviderForTests } from '@/server/infra/ai';
import { runDueJobs } from '@/server/jobs/runner';
import * as home from '@/app/api/v1/t/[tenantSlug]/loom/home/route';
import * as plans from '@/app/api/v1/t/[tenantSlug]/loom/plans/route';
import * as planActions from '@/app/api/v1/t/[tenantSlug]/loom/plans/[id]/actions/route';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as oppOne from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/route';
import * as comments from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/comments/route';
import * as platformKnowledge from '@/app/api/v1/platform/loom/knowledge/route';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { loomSalon } from '../helpers/loom-core';
import { platformUser } from '../helpers/platform';

afterEach(() => setAiProviderForTests(undefined));
afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', 'in', ['loom.analysis', 'loom.plan']).execute());
});

describe('Loom planner API and home page', () => {
  it('requests a plan as a job, shows the home page, plan actions, notes and «مرجع المنهجية»', async () => {
    setAiProviderForTests(null);
    const s = await loomSalon({ consents: true, name: 'Home Owner' });
    await analyzeNow(s.biz.tenantId);

    const req = await s.owner.call(plans.POST, { params: s.p, body: { kind: 'monthly' } });
    expect(req.status).toBe(202);
    await runDueJobs(50);
    const runs = await s.owner.call(plans.GET, { params: s.p });
    expect(runs.body.data[0]).toMatchObject({ kind: 'monthly', status: 'succeeded', source: 'rules', ai_reason: 'ai_disconnected' });
    expect(runs.body.data[0].note).toMatch(/الذكاء الاصطناعي غير متصل/);
    const planId = runs.body.data[0].plan_id;

    const acts = await s.owner.call(planActions.GET, { params: { ...s.p, id: planId } });
    expect(acts.status).toBe(200);
    expect(acts.body.data.actions.length).toBeGreaterThan(0);
    const a0 = acts.body.data.actions[0];
    expect(a0.operational.capacity.status).toBeTruthy();
    expect(typeof a0.operational.capacity.note).toBe('string');
    expect(acts.body.data.run.notes.length).toBeGreaterThan(0);

    const h = await s.owner.call(home.GET, { params: s.p });
    expect(h.status).toBe(200);
    const d = h.body.data;
    expect(d.situation.tiles.length).toBeGreaterThanOrEqual(4);
    expect(d.situation.quality.overall).toBeTruthy();
    expect(d.top_opportunities.length).toBeLessThanOrEqual(5);
    expect(d.plan.monthly.id).toBe(planId);
    expect(d.plan.last_run.source).toBe('rules');
    expect(d.results.status).toBe('not_available_yet');
    expect(d.setup.complete).toBe(false);
    expect(d.setup.missing.length).toBeGreaterThan(0);

    // Opportunity detail: «مرجع المنهجية» from the citations; notes.
    const list = await s.owner.call(opps.GET, { params: s.p });
    const id = list.body.data[0].card.opportunity_id;
    const c = await s.owner.call(comments.POST, { params: { ...s.p, id }, body: { body: 'نجرب الأسبوع القادم' } });
    expect(c.status).toBe(201);
    const one = await s.owner.call(oppOne.GET, { params: { ...s.p, id } });
    expect(one.body.data.knowledge.length).toBeGreaterThan(0);
    expect(one.body.data.knowledge[0].title).toBeTruthy();
    expect(one.body.data.comments.map((x: any) => x.body)).toEqual(['نجرب الأسبوع القادم']);
    expect((await s.owner.call(comments.GET, { params: { ...s.p, id } })).body.data).toHaveLength(1);
    expect((await s.owner.call(comments.POST, { params: { ...s.p, id }, body: { body: '' } })).status).toBe(422);
  });

  it('isolates citations, plan actions and comments between businesses (T12)', async () => {
    setAiProviderForTests(null);
    const a = await loomSalon({ name: 'Iso A' });
    const b = await loomSalon({ name: 'Iso B' });
    await analyzeNow(a.biz.tenantId);
    await analyzeNow(b.biz.tenantId);
    const ra = await generatePlanNow(a.biz.tenantId, { kind: 'monthly' });
    const aCites = await withTenant(a.biz.tenantId, (trx) => trx.selectFrom('loom.knowledge_citations').select('id').execute());
    expect(aCites.length).toBeGreaterThan(0);
    const seenByB = await withTenant(b.biz.tenantId, async (trx) => ({
      cites: await trx.selectFrom('loom.knowledge_citations').select('id').where('business_id', '=', a.biz.tenantId).execute(),
      actions: await trx.selectFrom('loom.plan_actions').select('id').where('business_id', '=', a.biz.tenantId).execute(),
      runs: await trx.selectFrom('loom.planner_runs').select('id').where('business_id', '=', a.biz.tenantId).execute(),
    }));
    expect(seenByB).toEqual({ cites: [], actions: [], runs: [] });
    // B cannot read A's plan actions or comment on A's opportunities through the API.
    expect((await b.owner.call(planActions.GET, { params: { ...b.p, id: ra!.plan_id! } })).status).toBe(404);
    const aOpp = await withTenant(a.biz.tenantId, (trx) => trx.selectFrom('loom.opportunities').select('id').executeTakeFirstOrThrow());
    expect((await b.owner.call(comments.POST, { params: { ...b.p, id: aOpp.id }, body: { body: 'x' } })).status).toBe(404);
    // Append-only: citations cannot be changed by the app role.
    await expect(withTenant(a.biz.tenantId, (trx) => trx.deleteFrom('loom.knowledge_citations').where('business_id', '=', a.biz.tenantId).execute())).rejects.toThrow();
  });

  it('knowledge retrieval is filtered by sector in the database too', async () => {
    const r = await withSystem('t', (trx) => retrieveKnowledge(trx, { sector: 'beauty', detector: 'slow_mover_bundle', intervention: 'restock', limit: 10 }, '2026-11-09'));
    expect(r.length).toBeGreaterThan(0);
    expect(r.map((x) => x.unit.id)).not.toContain('pb.retail.restock_fast_movers');
    const retail = await withSystem('t', (trx) => retrieveKnowledge(trx, { sector: 'retail', detector: 'slow_mover_bundle', limit: 10 }, '2026-11-09'));
    expect(retail.map((x) => x.unit.id)).toEqual(['pb.retail.restock_fast_movers']);
  });

  it('the platform owner sees the knowledge library read-only; others do not', async () => {
    const owner = await platformUser('platform_owner');
    const support = await platformUser('support_admin');
    const r = await owner.call(platformKnowledge.GET);
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThanOrEqual(16);
    expect(r.body.data[0]).toMatchObject({ id: expect.stringMatching(/^pb\./), version: 1, current: true, needs_review: false });
    expect((await support.call(platformKnowledge.GET)).status).toBe(404);
  });
});
