import { afterAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { analyzeNow, generatePlanNow } from '@/loom';
import '@/server/loom-host/planner-port';
import * as planList from '@/app/api/v1/t/[tenantSlug]/marketing/plans/route';
import * as planOne from '@/app/api/v1/t/[tenantSlug]/marketing/plans/[id]/route';
import * as planDiff from '@/app/api/v1/t/[tenantSlug]/marketing/plans/[id]/diff/route';
import * as planVersions from '@/app/api/v1/t/[tenantSlug]/marketing/plans/[id]/versions/route';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as oppOne from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/route';
import * as convert from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/convert/route';
import * as analyses from '@/app/api/v1/t/[tenantSlug]/loom/analyses/route';
import * as plannerRuns from '@/app/api/v1/t/[tenantSlug]/loom/plans/route';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { loomSalon } from '../helpers/loom-core';

/** LUMA-AUDIT-022/023/024/038/039 through the owner-facing API. */
afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', 'in', ['loom.analysis', 'loom.plan']).execute());
});

async function withPlan() {
  const s = await loomSalon({ consents: true });
  expect((await analyzeNow(s.biz.tenantId))?.status).toBe('succeeded');
  const run = await generatePlanNow(s.biz.tenantId, { kind: 'monthly' });
  expect(run?.status).toBe('succeeded');
  const plan = (await s.owner.call(planList.GET, { params: s.p, query: { kind: 'monthly' } })).body.data.find((p: any) => !p.is_example);
  return { ...s, planId: plan.id as string };
}

describe('Loom owner-facing display', () => {
  it('analysis status data: succeeded analyses and plan preparations are listed with timestamps (not «No analyses yet»)', async () => {
    const s = await withPlan();
    const a = (await s.owner.call(analyses.GET, { params: s.p })).body.data;
    expect(a[0]).toMatchObject({ status: 'succeeded' });
    expect(a[0].finished_at).toBeTruthy();
    const r = (await s.owner.call(plannerRuns.GET, { params: s.p })).body.data;
    expect(r[0]).toMatchObject({ kind: 'monthly', status: 'succeeded', source: 'rules' });
  });

  it('plans are localized to the reader, carry metric units (money in minor units) and honest provenance', async () => {
    const s = await withPlan();
    const ar = (await s.owner.call(planOne.GET, { params: { ...s.p, id: s.planId } })).body.data;
    s.owner.cookies.set('luma_locale', 'en');
    const en = (await s.owner.call(planOne.GET, { params: { ...s.p, id: s.planId } })).body.data;
    expect(ar.title).toMatch(/[؀-ۿ]/);
    expect(en.title).not.toMatch(/[؀-ۿ]/);
    expect((await s.owner.call(planList.GET, { params: s.p, query: { kind: 'monthly' } })).body.data.find((p: any) => p.id === s.planId).title).toBe(en.title);
    const v = en.versions[0];
    expect(v.provenance).toBe('rules');
    expect(v.localized_from_draft).toBe(true);
    expect(v.content.initiatives[0].title).not.toMatch(/[؀-ۿ]{3}.*[؀-ۿ]{3}/);
    const i = v.content.baseline.findIndex((b: any) => b.metric_key === 'sales.completed_net');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(v.display.baseline[i]).toEqual({ label: 'Completed sales (net)', unit: 'minor' });
    for (const d of [...v.display.baseline, ...v.display.metrics]) expect(d.label).not.toMatch(/@|[a-z]+\.[a-z_]+/);
  });

  it('opportunity evidence and success metrics have readable labels and units, never internal keys', async () => {
    const s = await withPlan();
    s.owner.cookies.set('luma_locale', 'en');
    const list = (await s.owner.call(opps.GET, { params: s.p })).body.data;
    expect(list.length).toBeGreaterThan(0);
    for (const o of list) {
      expect(o.display.success_metrics).toHaveLength(o.card.success_metrics.length);
      for (const m of o.display.success_metrics) expect(m.label).not.toMatch(/@|item:|offering:/);
    }
    const detail = (await s.owner.call(oppOne.GET, { params: { ...s.p, id: list[0].card.opportunity_id } })).body.data;
    expect(detail.evidence.length).toBeGreaterThan(0);
    for (const e of detail.evidence) {
      expect(e.label).toBeTruthy();
      expect(e.label).not.toMatch(/@|item:|offering:|slot:/);
      expect('unit' in e).toBe(true);
    }
  });

  it('converting an opportunity already in the plan adds nothing; a new one is labelled «added from an opportunity», and the comparison is human', async () => {
    const s = await withPlan();
    const plan = (await s.owner.call(planOne.GET, { params: { ...s.p, id: s.planId } })).body.data;
    const inPlan = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.plan_actions').select('opportunity_id').where('plan_version_id', '=', plan.versions[0].id).execute());
    const ids = new Set(inPlan.map((x) => x.opportunity_id).filter(Boolean));
    const list = (await s.owner.call(opps.GET, { params: s.p })).body.data;
    const already = list.find((o: any) => ids.has(o.card.opportunity_id));
    expect(already).toBeTruthy();
    s.owner.cookies.set('luma_locale', 'en'); // the requester's UI language must not create a second (English) copy
    const r = await s.owner.call(convert.POST, { params: { ...s.p, id: already.card.opportunity_id }, body: { target: 'plan_action' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.result.status).toBe('already_in_plan');
    const after = (await s.owner.call(planOne.GET, { params: { ...s.p, id: s.planId } })).body.data;
    expect(after.versions).toHaveLength(plan.versions.length);

    // A manual edit is «edited by you»; the comparison lists the change by item title, without JSON.
    const v1 = after.versions[0];
    const stored = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('plan_versions').select('content').where('id', '=', v1.id).executeTakeFirstOrThrow());
    const content = structuredClone(stored.content as any);
    content.activities[0].date_to = content.activities[0].date_from;
    const ed = await s.owner.call(planVersions.POST, { params: { ...s.p, id: s.planId }, body: { base_version: v1.version, content, change_note: 'shorter' } });
    expect(ed.status, JSON.stringify(ed.body)).toBeLessThan(300);
    const edited = (await s.owner.call(planOne.GET, { params: { ...s.p, id: s.planId } })).body.data;
    expect(edited.versions[0].provenance).toBe('user_edit');
    const diff = (await s.owner.call(planDiff.GET, { params: { ...s.p, id: s.planId }, query: { from: String(v1.version), to: String(v1.version + 1) } })).body.data;
    expect(diff.summary.length).toBeGreaterThan(0);
    expect(diff.summary[0]).toMatchObject({ section: 'activity', field: 'date_to', kind: 'changed' });
    expect(typeof diff.summary[0].item).toBe('string');
  });
});
