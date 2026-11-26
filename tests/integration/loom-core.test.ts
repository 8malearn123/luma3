import { afterAll, describe, expect, it } from 'vitest';
import { sql, withSystem, withTenant } from '@/server/db/client';
import { buildSnapshot } from '@/server/domains/marketing/snapshot';
import { analyzeNow, connectorFor, ensureConnection, loadDataset, MetricContext, computeMetrics, opportunityCardSchema } from '@/loom';
import { runDueJobs } from '@/server/jobs/runner';
import * as analyses from '@/app/api/v1/t/[tenantSlug]/loom/analyses/route';
import * as analysisOne from '@/app/api/v1/t/[tenantSlug]/loom/analyses/[id]/route';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as oppOne from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/route';
import * as dq from '@/app/api/v1/t/[tenantSlug]/loom/data-quality/route';
import * as connections from '@/app/api/v1/t/[tenantSlug]/loom/connections/route';
import { localToday, addDays } from '@/server/domains/analytics/period';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { loomSalon, materialRecipe } from '../helpers/loom-core';

afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', '=', 'loom.analysis').execute());
});

async function dataset(tenantId: string) {
  const conn = await withTenant(tenantId, (trx) => ensureConnection(trx, tenantId));
  return loadDataset(connectorFor('luma'), conn);
}

describe('LUMA connector (loom_export views)', () => {
  it('returns canonical, pseudonymous records through tenant-scoped views', async () => {
    const s = await loomSalon();
    const ds = await dataset(s.biz.tenantId);
    expect(ds.business.id).toBe(s.biz.tenantId);
    expect(ds.offerings.filter((o) => o.kind === 'service').map((o) => o.id).sort()).toEqual([s.s1, s.s2].sort());
    expect(ds.transactions.filter((t) => t.status === 'fulfilled')).toHaveLength(30);
    expect(ds.transactions.every((t) => t.consistent)).toBe(true);
    expect(ds.requirements.filter((r) => r.type === 'skill' && r.ref_id === s.A)).toHaveLength(2);
    expect(ds.resources.find((r) => r.id === s.A)!.skills.sort()).toEqual([s.s1, s.s2].sort());
    expect(ds.capacity.some((w) => w.state === 'free')).toBe(true);
    expect(ds.costs.find((c) => c.type === 'material' && c.scope.kind === 'offering' && c.scope.offering_id === s.s1)).toMatchObject({ amount_minor: 4000, completeness: 'complete' });
    expect(ds.costs.find((c) => c.type === 'payment_fee')).toMatchObject({ basis: 'not_tracked' });
    // No customer names, phones, e-mails or row ids leave LUMA.
    const json = JSON.stringify(ds);
    expect(json).not.toMatch(/Private Name|\+96655|secret\d|example\.test/);
    for (const c of s.customers) expect(json).not.toContain(c);
    expect(ds.customers.every((c) => /^c_[0-9a-f]{20}$/.test(c.pseudo_id))).toBe(true);
  });

  it('matches the existing marketing snapshot on the shared metrics (phase-1 parity)', async () => {
    const s = await loomSalon();
    const ds = await dataset(s.biz.tenantId);
    const m = computeMetrics(new MetricContext(ds, { cost_completeness_threshold: 0.8 }));
    const today = localToday('Asia/Riyadh');
    const old = await withTenant(s.biz.tenantId, (trx) => buildSnapshot(trx, s.biz.tenantId, { kind: 'parity', from: today, to: addDays(today, 29) }));
    const om = old.data.metrics;
    const bookings90 = new MetricContext(ds, { cost_completeness_threshold: 0.8 }).tx90.filter((t) => t.kind === 'booking');
    expect(bookings90.filter((t) => t.status === 'fulfilled').length).toBe(om['bookings.completed_90d']!.value);
    expect(bookings90.filter((t) => t.status.startsWith('cancelled')).length).toBe(om['bookings.cancelled_90d']!.value);
    expect(bookings90.filter((t) => t.status === 'fulfilled').reduce((a, t) => a + t.total_minor - t.refunded_minor, 0)).toBe(om['bookings.net_revenue_90d_minor']!.value);
    expect(m.value('customers.total')).toBe(om['customers.total']!.value);
    expect(m.value('capacity.free_minutes_next14')).toBe(om['capacity.next14.free_min']!.value);
    for (const svc of old.data.services) expect(m.value('sales.completed_count', `offering:${svc.id}`) ?? 0).toBeGreaterThanOrEqual(svc.demand.completed);
  });

  it('isolation (T12): views, loom tables and the API never cross businesses', async () => {
    const a = await loomSalon({ name: 'Owner A' });
    const b = await loomSalon({ name: 'Owner B' });
    await analyzeNow(a.biz.tenantId);
    await analyzeNow(b.biz.tenantId);
    // Views run as the caller: B's scope sees only B; system scope sees nothing (no current tenant).
    const inB = await withTenant(b.biz.tenantId, (trx) => trx.selectFrom('loom_export.offerings').select('id').execute());
    expect(inB.map((r) => r.id)).not.toContain(a.s1);
    const sys = await withSystem('test: export views without tenant', (trx) => sql<{ n: number }>`select count(*)::int as n from loom_export.transactions`.execute(trx));
    expect(sys.rows[0]!.n).toBe(0);
    const aOpps = await withTenant(a.biz.tenantId, (trx) => trx.selectFrom('loom.opportunities').select(['id']).execute());
    expect(aOpps.length).toBeGreaterThan(0);
    const leak = await withTenant(b.biz.tenantId, (trx) => trx.selectFrom('loom.opportunities').select('id').where('id', 'in', aOpps.map((o) => o.id)).execute());
    expect(leak).toEqual([]);
    for (const t of ['loom.metric_values', 'loom.analyses', 'loom.data_quality_checks', 'loom.opportunity_evidence', 'loom.business_profile_facts'] as const) {
      const rows = await withTenant(b.biz.tenantId, (trx) => trx.selectFrom(t).select('business_id').execute());
      expect(rows.every((r) => r.business_id === b.biz.tenantId)).toBe(true);
    }
    // RLS also refuses writes into another business.
    await expect(withTenant(b.biz.tenantId, (trx) => trx.insertInto('loom.business_goals').values({ business_id: a.biz.tenantId, kind: 'fill_quiet_times', priority: 'primary' }).execute())).rejects.toThrow();
    const r = await b.owner.call(oppOne.GET, { params: { ...b.p, id: aOpps[0]!.id } });
    expect(r.status).toBe(404);
    const list = await b.owner.call(opps.GET, { params: b.p });
    expect(list.body.data.every((o: any) => o.card.business_id === b.biz.tenantId)).toBe(true);
    // A cannot address B's workspace at all.
    expect((await a.owner.call(opps.GET, { params: b.p })).status).toBe(404);
  });
});

describe('Loom analysis through the API (rules path)', () => {
  it('queues an analysis (202), runs it as a job and serves §11.1 cards with evidence, checks and history', async () => {
    const s = await loomSalon({ s2Cost: null, consents: true });
    const q = await s.owner.call(analyses.POST, { params: s.p, body: {} });
    expect(q.status).toBe(202);
    const again = await s.owner.call(analyses.POST, { params: s.p, body: {} });
    expect(again.status).toBe(200);
    expect(again.body.data.job_id).toBe(q.body.data.job_id);
    await runDueJobs(50);
    const job = await s.owner.call(analysisOne.GET, { params: { ...s.p, id: q.body.data.job_id } });
    expect(job.body.data).toMatchObject({ status: 'succeeded', mode: 'standard' });
    expect(job.body.data.result.snapshot.connector).toBe('luma');
    expect(job.body.data.result.setup.complete).toBe(false);

    const quality = await s.owner.call(dq.GET, { params: s.p });
    expect(quality.body.data.report.domains.economics.improve[0]).toMatch(/سجّلي تكلفة|Record the cost/);

    const list = await s.owner.call(opps.GET, { params: s.p });
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(1);
    for (const o of list.body.data) {
      const parsed = opportunityCardSchema.safeParse(o.card);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    // T1 end to end: S2 has sales but no cost.
    const blocker = list.body.data.find((o: any) => o.card.category === 'missing_cost_blocker');
    expect(blocker).toBeTruthy();
    const s2Cards = list.body.data.filter((o: any) => o.detector_id === 'high_satisfaction_low_demand');
    expect(s2Cards).toHaveLength(1);
    expect(s2Cards[0].card.margin_check).toMatchObject({ status: 'costs_incomplete', unit_margin_before_minor: null });
    // T3 end to end: no recipe ⇒ no count.
    expect(s2Cards[0].card.inventory_check).toEqual({ status: 'no_recipe', covers_n: null });

    const one = await s.owner.call(oppOne.GET, { params: { ...s.p, id: s2Cards[0].card.opportunity_id } });
    expect(one.body.data.evidence.map((e: any) => e.id).sort()).toEqual([...one.body.data.card.evidence_refs].sort());
    expect(one.body.data.checks.map((c: any) => c.type).sort()).toEqual(['capacity', 'inventory', 'margin', 'preferences']);
    expect(one.body.data.events.map((e: any) => e.event)).toEqual(['detected', 'proposed']);

    // Stored evidence trail: metric values, definitions mirror, sync run, quality report.
    const counts = await withTenant(s.biz.tenantId, async (trx) => ({
      values: (await trx.selectFrom('loom.metric_values').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()).n,
      runs: (await trx.selectFrom('loom.sync_runs').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()).n,
      defs: (await trx.selectFrom('loom.metric_definitions').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()).n,
    }));
    expect(counts.values).toBeGreaterThan(30);
    expect(counts.runs).toBe(1);
    expect(counts.defs).toBeGreaterThanOrEqual(35);
    // Append-only trails.
    await expect(withTenant(s.biz.tenantId, (trx) => trx.updateTable('loom.opportunity_events').set({ note: 'x' }).execute())).rejects.toThrow();
    await expect(withTenant(s.biz.tenantId, (trx) => trx.deleteFrom('loom.opportunity_evidence').execute())).rejects.toThrow();

    // Connections: owner (business.manage) only.
    const conn = await s.owner.call(connections.GET, { params: s.p });
    expect(conn.body.data[0]).toMatchObject({ kind: 'luma', status: 'active', health: { status: 'ok' } });
  });

  it('re-analysis dedupes by fingerprint: the same opportunity is reassessed, not duplicated', async () => {
    const s = await loomSalon();
    await analyzeNow(s.biz.tenantId);
    const first = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.opportunities').select(['id', 'fingerprint']).execute());
    const r2 = await analyzeNow(s.biz.tenantId);
    expect((r2!.result.snapshot as { reused: boolean }).reused).toBe(true);
    const second = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.opportunities').select(['id', 'fingerprint']).execute());
    expect(second.map((x) => x.id).sort()).toEqual(first.map((x) => x.id).sort());
    const ev = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.opportunity_events').select('event').where('opportunity_id', '=', first[0]!.id).orderBy('created_at').execute());
    expect(ev.map((e) => e.event)).toEqual(['detected', 'proposed', 'reassessed']);
  });

  it('T2 end to end: an approved recipe with too little stock ⇒ reorder_needed with the exact covers_n', async () => {
    const s = await loomSalon();
    await materialRecipe(s.biz, s.s2, { onHand: 40, perService: 30 });
    await analyzeNow(s.biz.tenantId);
    const list = await s.owner.call(opps.GET, { params: s.p });
    const card = list.body.data.find((o: any) => o.detector_id === 'high_satisfaction_low_demand').card;
    expect(card.inventory_check).toEqual({ status: 'reorder_needed', covers_n: 1 });
    expect(card.prerequisites.join(' ')).toMatch(/إعادة طلب|Reorder/);
  });

  it('T7: a stale market signal (> 45 days) is reported as stale and never as a live signal', async () => {
    const s = await loomSalon();
    await withTenant(s.biz.tenantId, (trx) => trx.insertInto('trend_observations').values([
      { tenant_id: s.biz.tenantId, url: 'https://example.com/old', title: 'Old trend', evidence_strength: 'anecdotal', content_hash: 'h-old', published_at: new Date(Date.now() - 60 * 86_400_000) },
      { tenant_id: s.biz.tenantId, url: 'https://example.com/new', title: 'New trend', evidence_strength: 'anecdotal', content_hash: 'h-new', published_at: new Date(Date.now() - 3 * 86_400_000) },
    ]).execute());
    const r = await analyzeNow(s.biz.tenantId);
    const ms = r!.result.market_signals as { live: string[]; stale: Array<{ id: string; freshness: string }> };
    expect(ms.live).toHaveLength(1);
    expect(ms.stale).toHaveLength(1);
    expect(ms.stale[0]!.freshness).toBe('stale');
    expect(ms.live).not.toContain(ms.stale[0]!.id);
  });

  it('T11: a new business gets an exploratory analysis with the data it needs', async () => {
    const s = await loomSalon({ ageDays: 5 });
    const r = await analyzeNow(s.biz.tenantId);
    expect(r!.result.mode).toBe('exploratory');
    expect((r!.result.data_needed as unknown[]).length).toBeGreaterThan(0);
    expect((r!.result.suppressed as Array<{ reason: string }>).some((x) => x.reason === 'exploratory_no_segmentation')).toBe(true);
    const cards = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.opportunities').select(['card', 'evidence_strength']).execute());
    for (const c of cards) expect(['strong', 'moderate']).not.toContain(c.evidence_strength);
  });
});
