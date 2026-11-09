import { afterAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { analyzeNow, ensureConnection, processChanges, recordChange } from '@/loom';
import { moveStock } from '@/server/domains/commerce/stock';
import { runOutbox } from '@/server/jobs/runner';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as oppOne from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/route';
import * as decision from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/decision/route';
import * as convert from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/convert/route';
import * as changes from '@/app/api/v1/t/[tenantSlug]/loom/changes/route';
import * as initiativeOne from '@/app/api/v1/t/[tenantSlug]/loom/initiatives/[id]/route';
import * as results from '@/app/api/v1/t/[tenantSlug]/loom/results/route';
import * as transition from '@/app/api/v1/t/[tenantSlug]/marketing/plans/[id]/transition/route';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { approvedLeave, loomSalon, materialRecipe } from '../helpers/loom-core';

afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', 'like', 'loom.%').execute());
});

type Salon = Awaited<ReturnType<typeof loomSalon>>;
const cards = async (s: Salon) => (await s.owner.call(opps.GET, { params: s.p })).body.data as any[];
const MIN = 60_000;

/** Approves the S2 opportunity, converts it into a plan action and approves that plan. */
async function approvedPlanFor(s: Salon) {
  await analyzeNow(s.biz.tenantId);
  const o = (await cards(s)).find((x) => x.detector_id === 'high_satisfaction_low_demand');
  expect(o).toBeTruthy();
  const params = { ...s.p, id: o.card.opportunity_id };
  await s.owner.call(decision.POST, { params, body: { action: 'approve' } });
  const cv = await s.owner.call(convert.POST, { params, body: { target: 'plan_action' } });
  expect(cv.status).toBe(201);
  const planId = cv.body.data.result.ref_id as string;
  const ap = await s.owner.call(transition.POST, { params: { ...s.p, id: planId }, body: { action: 'approve' } });
  expect(ap.status).toBe(200);
  const plan = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('marketing_plans').select(['status', 'approved_version_id', 'current_version_id']).where('id', '=', planId).executeTakeFirstOrThrow());
  expect(plan.status).toBe('approved');
  const approved = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('plan_versions').select(['content', 'version']).where('id', '=', plan.approved_version_id!).executeTakeFirstOrThrow());
  return { o, planId, plan, approved };
}

describe('T10: data changes after a plan was approved', () => {
  it('a material stockout proposes a revision version with its reason; the approved version is untouched', async () => {
    const s = await loomSalon({ consents: true });
    const item = await materialRecipe(s.biz, s.s2, { onHand: 100, perService: 1 });
    await withTenant(s.biz.tenantId, (trx) => trx.updateTable('inventory_items').set({ low_stock_threshold: 50 }).where('id', '=', item).execute());
    const { o, planId, plan, approved } = await approvedPlanFor(s);

    // A LUMA stock movement (consumption) takes the material under its reorder level.
    await withTenant(s.biz.tenantId, (trx) => moveStock(trx, s.biz.tenantId, item, { kind: 'adjustment', quantity: -95, dOnHand: -95, dReserved: 0, reason: 'test' }));
    await runOutbox(100);
    const pending = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.change_signals').selectAll().execute());
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ type: 'inventory', scope: `item:${item}`, status: 'pending', magnitude: 5, threshold: 50 });

    // Before the cool-down nothing is processed; after it, only the affected checks re-run.
    expect((await processChanges(s.biz.tenantId)).processed).toBe(0);
    const sum = await processChanges(s.biz.tenantId, { now: new Date(Date.now() + 31 * MIN) });
    expect(sum.processed).toBe(1);
    expect(sum.rechecked).toBeGreaterThanOrEqual(1);
    expect(sum.revisions).toEqual([{ plan_id: planId, version: approved.version + 1, signal_id: pending[0]!.id }]);

    const after = await withTenant(s.biz.tenantId, async (trx) => ({
      plan: await trx.selectFrom('marketing_plans').select(['status', 'approved_version_id', 'current_version_id']).where('id', '=', planId).executeTakeFirstOrThrow(),
      versions: await trx.selectFrom('plan_versions').select(['id', 'version', 'content', 'change_note', 'validation']).where('plan_id', '=', planId).orderBy('version').execute(),
    }));
    // The approved version and pointer did not change; the revision is a new, unapproved version.
    expect(after.plan.status).toBe('approved');
    expect(after.plan.approved_version_id).toBe(plan.approved_version_id);
    expect(after.versions.find((v) => v.id === plan.approved_version_id)!.content).toEqual(approved.content);
    const rev = after.versions.at(-1)!;
    expect(after.plan.current_version_id).toBe(rev.id);
    expect(rev.change_note).toMatch(/^loom_revision:inventory:/);
    expect((rev.validation as any).loom_revision.reason.text.ar).toMatch(/حد إعادة الطلب/);
    expect((rev.content as any).limitations).toMatch(/\[لووم/);
    expect((rev.content as any).activities.some((a: any) => /\[لووم\]/.test(a.capacity_note ?? ''))).toBe(true);

    // The opportunity's inventory check was re-run (no analysis, no model) and the card shows it.
    const detail = (await s.owner.call(oppOne.GET, { params: { ...s.p, id: o.card.opportunity_id } })).body.data;
    expect(detail.card.inventory_check.status).toBe('constrained');
    expect(detail.events.at(-1)).toMatchObject({ event: 'reassessed', reason: 'change:inventory' });
    const analyses = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.analyses').select('id').execute());
    expect(analyses).toHaveLength(1);

    // Re-processing is idempotent: no second revision.
    expect((await processChanges(s.biz.tenantId, { now: new Date(Date.now() + 40 * MIN) })).revisions).toEqual([]);
    const list = (await s.owner.call(changes.GET, { params: s.p })).body.data;
    expect(list[0]).toMatchObject({ type: 'inventory', status: 'processed', rechecked: 1 });
    expect(list[0].revisions).toHaveLength(1);
    const summary = (await s.owner.call(results.GET, { params: s.p })).body.data;
    expect(summary.alerts).toHaveLength(1);
    expect(summary.counts).toEqual({ scheduled: 1 });
  });

  it('approved leave shrinking a promoted window by more than 20% re-checks capacity and proposes a revision', async () => {
    const s = await loomSalon({ s2Staff: 'B', consents: true });
    const { planId, approved } = await approvedPlanFor(s);
    await approvedLeave(s.biz, s.B!, 15);
    const now = new Date();
    const r = await withTenant(s.biz.tenantId, (trx) => recordChange(trx, s.biz.tenantId, { type: 'capacity', scope: `staff:${s.B}`, data: { from: now.toISOString(), to: now.toISOString() } }, { now }));
    expect(r).toBe('created');
    const sum = await processChanges(s.biz.tenantId, { now: new Date(now.getTime() + 31 * MIN) });
    expect(sum.processed).toBe(1);
    expect(sum.revisions.map((x) => x.plan_id)).toEqual([planId]);
    expect(sum.revisions[0]!.version).toBe(approved.version + 1);
    const sig = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.change_signals').select(['magnitude', 'result']).executeTakeFirstOrThrow());
    expect(sig.magnitude).toBeGreaterThan(0.2);
    expect((sig.result as any).rechecked[0]).toMatchObject({ check: 'capacity', status: 'blocked' });
  });
});

describe('Change aggregator: thresholds, cool-down, no duplicates, isolation', () => {
  it('drops events under the threshold, aggregates repeats, suppresses during the cool-down', async () => {
    const s = await loomSalon();
    const biz = s.biz.tenantId;
    await withTenant(biz, (trx) => ensureConnection(trx, biz));
    const t0 = new Date();
    const at = (min: number) => new Date(t0.getTime() + min * MIN);
    const rec = (data: { price_before: number; price_after: number; cost_before: number | null; cost_after: number | null }, now: Date) =>
      withTenant(biz, (trx) => recordChange(trx, biz, { type: 'margin', scope: `offering:${s.s1}`, data }, { now }));
    // 20000/4000 → 20500/4000: margin moves 3% (< 10%) ⇒ no signal.
    expect(await rec({ price_before: 20000, price_after: 20500, cost_before: 4000, cost_after: 4000 }, t0)).toBe('below_threshold');
    // Stock still above its reorder level ⇒ no signal.
    expect(await withTenant(biz, (trx) => recordChange(trx, biz, { type: 'inventory', scope: 'item:abc', data: { available: 80, reorder_level: 50 } }, { now: t0 }))).toBe('below_threshold');
    // 20000 → 23000 moves the margin 18.75% ⇒ a signal; a second event aggregates into it.
    expect(await rec({ price_before: 20000, price_after: 23000, cost_before: 4000, cost_after: 4000 }, t0)).toBe('created');
    expect(await rec({ price_before: 23000, price_after: 26000, cost_before: 4000, cost_after: 4000 }, at(5))).toBe('aggregated');
    let rows = await withTenant(biz, (trx) => trx.selectFrom('loom.change_signals').selectAll().execute());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ occurrences: 2, status: 'pending' });
    expect(rows[0]!.due_at.getTime()).toBe(at(30).getTime());
    // Not due yet.
    expect((await processChanges(biz, { now: at(10) })).processed + (await processChanges(biz, { now: at(10) })).not_relevant).toBe(0);
    const sum = await processChanges(biz, { now: at(31) });
    expect(sum.processed + sum.not_relevant + sum.below_threshold).toBe(1);
    // Within the cool-down after processing: counted as suppressed, no new signal.
    expect(await rec({ price_before: 26000, price_after: 30000, cost_before: 4000, cost_after: 4000 }, at(40))).toBe('cooling_down');
    rows = await withTenant(biz, (trx) => trx.selectFrom('loom.change_signals').selectAll().execute());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.suppressed).toBe(1);
    // After the cool-down a new signal is created.
    expect(await rec({ price_before: 30000, price_after: 40000, cost_before: 4000, cost_after: 4000 }, at(70))).toBe('created');
    expect(await withTenant(biz, (trx) => trx.selectFrom('loom.change_signals').select('id').execute())).toHaveLength(2);
    // The partial unique index refuses a second pending signal for the same key.
    await expect(withTenant(biz, (trx) => trx.insertInto('loom.change_signals').values({ business_id: biz, type: 'margin', scope: `offering:${s.s1}`, due_at: new Date() }).execute())).rejects.toThrow();
  });

  it('a business without Loom records nothing; signals and initiatives never cross businesses', async () => {
    const a = await loomSalon({ name: 'Owner A', consents: true });
    const b = await loomSalon({ name: 'Owner B' });
    // B has no Loom connection yet: events are ignored.
    expect(await withTenant(b.biz.tenantId, (trx) => recordChange(trx, b.biz.tenantId, { type: 'capacity', scope: `staff:${b.A}`, data: { from: '', to: '' } }))).toBe('not_engaged');
    await analyzeNow(a.biz.tenantId);
    await analyzeNow(b.biz.tenantId);
    const o = (await cards(a)).find((x) => x.status === 'proposed');
    await a.owner.call(convert.POST, { params: { ...a.p, id: o.card.opportunity_id }, body: { target: 'plan_action' } });
    await withTenant(a.biz.tenantId, (trx) => recordChange(trx, a.biz.tenantId, { type: 'capacity', scope: `staff:${a.A}`, data: { from: '', to: '' } }));
    const initA = await withTenant(a.biz.tenantId, (trx) => trx.selectFrom('loom.initiatives').select('id').executeTakeFirstOrThrow());
    for (const t of ['loom.change_signals', 'loom.initiatives', 'loom.decision_history'] as const) {
      expect(await withTenant(b.biz.tenantId, (trx) => trx.selectFrom(t).select('business_id').execute())).toEqual([]);
    }
    expect((await b.owner.call(initiativeOne.GET, { params: { ...b.p, id: initA.id } })).status).toBe(404);
    expect((await b.owner.call(changes.GET, { params: b.p })).body.data).toEqual([]);
    // Processing B touches nothing of A.
    expect((await processChanges(b.biz.tenantId, { now: new Date(Date.now() + 60 * MIN) })).processed).toBe(0);
    expect(await withTenant(a.biz.tenantId, (trx) => trx.selectFrom('loom.change_signals').select('status').execute())).toEqual([{ status: 'pending' }]);
    await expect(withTenant(b.biz.tenantId, (trx) => trx.insertInto('loom.change_signals').values({ business_id: a.biz.tenantId, type: 'margin', scope: 'offering:x', due_at: new Date() }).execute())).rejects.toThrow();
  });
});
